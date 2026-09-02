import { toErrorMessage } from '@infra/utils/error.util';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { appendTimeContext } from '@resolution/signal/markers';
import { formatCurrentTime } from '@infra/utils/date.util';
import { MemoryConfig } from '../memory.config';
import type { ShortTermMessage } from './short-term.types';
import {
  buildChatHistoryCacheKey,
  parseCachedChatHistoryMessages,
  rebuildChatHistoryCache,
  serializeCachedChatHistoryMessage,
} from './chat-history-cache.util';
import { MEMORY_CHAT_SESSION_PORT, type MemoryChatSessionPort } from '../memory.ports';

/**
 * 短期记忆服务 — 对话窗口管理
 *
 * 热路径读 Redis 窗口缓存（provenance 版本校验），miss/降版本回退 chat_messages
 * （Supabase 永久存储）最近 N 条并回填缓存；两条路径都在内存里套同一个滚动历史窗口
 * （见 applyRollingWindow），再按本批上界与字符上限裁剪后输出给 Agent。
 */
@Injectable()
export class MessageWindowService {
  private readonly logger = new Logger(MessageWindowService.name);
  public lastLoadError: string | null = null;

  constructor(
    @Inject(MEMORY_CHAT_SESSION_PORT)
    private readonly chatSession: MemoryChatSessionPort,
    private readonly config: MemoryConfig,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * 获取会话的短期记忆（裁剪后的消息窗口）
   *
   * 1. 优先读 Redis 窗口缓存；miss/降版本回退 chat_messages（最近 N 条硬上限）并回填缓存
   * 2. 本批上界裁剪 + 滚动历史窗口（锚点 = 本批之前候选人最后一次开口）
   * 3. 注入时间上下文，按字符上限裁剪
   */
  async getMessages(
    chatId: string,
    options?: { endTimeInclusive?: number },
  ): Promise<ShortTermMessage[]> {
    this.lastLoadError = null;

    try {
      const cached = await this.getCachedHistory(chatId);
      const cacheHasProvenance =
        cached.length > 0 && cached.every((message) => message.provenanceVersion === 2);
      // 命中与 miss 同一口径：缓存与 DB 都只按条数封顶，语义窗口统一在内存里套。
      const cachedHistory = this.applyRollingWindow(
        this.applyTimeBoundary(cached, options?.endTimeInclusive),
      );
      if (cacheHasProvenance && cachedHistory.length > 0) {
        return this.trimByChars(this.injectTimeContext(cachedHistory));
      }
      if (cached.length > 0 && !cacheHasProvenance) {
        // 滚动发布兼容：旧实例写入的 v1 entry 仍可被旧代码读取；新实例发现后
        // 原地重建同一个 key，不切前缀，避免 v1/v2 双 key 导致消息窗口分叉。
        await this.redisService?.del(buildChatHistoryCacheKey(chatId));
      }

      // DB 只按条数封顶，不带时间谓词：滚动窗口的锚点是上一次开口而非当前时间，
      // 按 now 过滤会让隔半月回访的候选人拿到空窗口。endTimeInclusive 也不下推 SQL：
      // 边界要区分角色（见 applyTimeBoundary），且缓存回填须保留完整快照——裁剪只是读取时的视图。
      const rawHistory = await this.chatSession.getChatHistory(
        chatId,
        this.config.sessionWindowMaxMessages,
      );
      await this.backfillCache(chatId, rawHistory);

      return this.trimByChars(
        this.injectTimeContext(
          this.applyRollingWindow(this.applyTimeBoundary(rawHistory, options?.endTimeInclusive)),
        ),
      );
    } catch (error) {
      this.lastLoadError = toErrorMessage(error);
      this.logger.error(`获取短期记忆失败 [${chatId}]:`, error);
      return [];
    }
  }

  private injectTimeContext(
    messages: Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      source?: ShortTermMessage['source'];
      messageType?: ShortTermMessage['messageType'];
      isSelf?: boolean;
      payloadSource?: string;
    }>,
  ): ShortTermMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: appendTimeContext(msg.content, formatCurrentTime(msg.timestamp)),
      source: msg.source,
      messageType: msg.messageType,
      isSelf: msg.isSelf,
      payloadSource: msg.payloadSource,
    }));
  }

  /**
   * 按触发消息时间戳裁剪窗口，但保留边界后已投递的 assistant 消息。
   *
   * 边界只防「更晚到的用户输入」泄进本轮（那属于下一轮 debounce 批次）；assistant
   * 一旦入库即已发给候选人，裁掉会让下一轮看不见刚发出的内容而重发。
   *
   * 边界后的 assistant 插到末尾 user 触发块之前，维持「窗口以本轮用户输入收尾」的
   * 下游不变量（trailingUserMessages、图片注入）。边界内无消息时返回空，保持调用方
   * 的缓存 miss 回退语义。
   */
  private applyTimeBoundary<T extends { timestamp: number; role: 'user' | 'assistant' }>(
    messages: T[],
    endTimeInclusive?: number,
  ): T[] {
    if (!Number.isFinite(endTimeInclusive)) return messages;
    const bounded = messages.filter((message) => message.timestamp <= endTimeInclusive);
    if (bounded.length === 0) return bounded;

    const lateAssistant = messages.filter(
      (message) => message.timestamp > endTimeInclusive && message.role === 'assistant',
    );
    if (lateAssistant.length === 0) return bounded;

    let trailingUserStart = bounded.length;
    while (trailingUserStart > 0 && bounded[trailingUserStart - 1].role === 'user') {
      trailingUserStart -= 1;
    }
    return [
      ...bounded.slice(0, trailingUserStart),
      ...lateAssistant,
      ...bounded.slice(trailingUserStart),
    ];
  }

  /**
   * 滚动历史窗口：锚点 = 本批之前候选人最后一次开口，保留 [锚点 − historyWindow, ∞)。
   *
   * 「本批」不需要调用方告知——上界裁剪后窗口末尾的连续 user 块就是本轮输入（与
   * conversation-normalizer 的 trailingUserMessages 同一定义）；跳过这块再往前遇到的
   * 第一条 user 就是锚点。于是：连续咨询与按当前时间回看等价；隔半月回访捡回上一段
   * 咨询的最后 7 天而不是空窗口；沉默期间的复聊触达 / 真人消息比锚点新，自然带上。
   * 首次咨询（没有更早的 user）不裁。
   */
  private applyRollingWindow<T extends { timestamp: number; role: 'user' | 'assistant' }>(
    messages: T[],
  ): T[] {
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role === 'user') index -= 1;
    while (index >= 0 && messages[index].role !== 'user') index -= 1;
    if (index < 0) return messages;

    const startTimeInclusive = messages[index].timestamp - this.config.historyWindowSeconds * 1000;
    return messages.filter((message) => message.timestamp >= startTimeInclusive);
  }

  private async getCachedHistory(
    chatId: string,
  ): Promise<ReturnType<typeof parseCachedChatHistoryMessages>> {
    if (!this.redisService) return [];

    const rawMessages = await this.redisService
      .lrange<string>(buildChatHistoryCacheKey(chatId), 0, -1)
      .catch((error) => {
        this.logger.warn(`读取短期记忆缓存失败 [${chatId}]`, error);
        return [];
      });

    return parseCachedChatHistoryMessages(rawMessages);
  }

  private async backfillCache(
    chatId: string,
    messages: Array<{
      messageId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      source?: ShortTermMessage['source'];
      messageType?: ShortTermMessage['messageType'];
      isSelf?: boolean;
      payloadSource?: string;
    }>,
  ): Promise<void> {
    if (!this.redisService || messages.length === 0) return;

    const serializedMessages = messages.map((message) =>
      serializeCachedChatHistoryMessage({
        chatId,
        messageId: message.messageId,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        source: message.source,
        messageType: message.messageType,
        isSelf: message.isSelf,
        payloadSource: message.payloadSource,
        provenanceVersion: 2,
      }),
    );

    // 这是 list 的唯一创建点（写路径 RPUSHX 只追加不建 key），整段原子重建。
    await rebuildChatHistoryCache(this.redisService, chatId, serializedMessages, {
      maxMessages: this.config.sessionWindowMaxMessages,
      ttlSeconds: this.config.sessionTtl,
    });
  }

  /**
   * 字符上限裁剪 — 从最早的消息开始丢弃，保留最新的
   */
  private trimByChars(messages: ShortTermMessage[]): ShortTermMessage[] {
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    if (totalChars <= this.config.sessionWindowMaxChars) return messages;

    this.logger.warn(
      `会话窗口总长度 ${totalChars} 超过上限 ${this.config.sessionWindowMaxChars}，将丢弃最早的消息`,
    );

    const kept: ShortTermMessage[] = [];
    let charCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgLen = messages[i].content?.length ?? 0;
      if (charCount + msgLen > this.config.sessionWindowMaxChars && kept.length > 0) break;
      kept.unshift(messages[i]);
      charCount += msgLen;
    }

    this.logger.warn(`保留最近 ${kept.length}/${messages.length} 条消息，共 ${charCount} 字符`);
    return kept;
  }
}
