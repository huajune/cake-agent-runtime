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
  serializeCachedChatHistoryMessage,
} from './chat-history-cache.util';
import { MEMORY_CHAT_SESSION_PORT, type MemoryChatSessionPort } from '../memory.ports';

/**
 * 短期记忆服务 — 对话窗口管理
 *
 * 热路径读 Redis 窗口缓存（provenance 版本校验），miss/降版本回退 chat_messages
 * （Supabase 永久存储）并回填缓存；按窗口策略（条数 + 时间 + 字符上限）裁剪后输出给 Agent。
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
   * 1. 优先读 Redis 窗口缓存；miss/降版本回退 chat_messages（最近 N 条 + 时间窗口）并回填缓存
   * 2. 注入时间上下文
   * 3. 按字符上限裁剪
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
      const cachedHistory = this.applyTimeBoundary(cached, options?.endTimeInclusive);
      if (cacheHasProvenance && cachedHistory.length > 0) {
        return this.trimByChars(this.injectTimeContext(cachedHistory));
      }
      if (cached.length > 0 && !cacheHasProvenance) {
        // 滚动发布兼容：旧实例写入的 v1 entry 仍可被旧代码读取；新实例发现后
        // 原地重建同一个 key，不切前缀，避免 v1/v2 双 key 导致消息窗口分叉。
        await this.redisService?.del(buildChatHistoryCacheKey(chatId));
      }

      const rawHistory = await this.chatSession.getChatHistory(
        chatId,
        this.config.sessionWindowMaxMessages,
        {
          // 使用独立的历史回查窗口（historyWindowSeconds），而非 sessionTtl。
          // sessionTtl 只控制 Redis 会话状态的生命周期；用户跨天回来续聊时，
          // Redis facts 可能已过期，但 Supabase 历史依然要能追溯，避免被当新用户对待。
          startTimeInclusive: Date.now() - this.config.historyWindowSeconds * 1000,
          // endTimeInclusive 不下推到 SQL：边界需要区分角色（只裁 user、保留
          // 已投递的 assistant），由 applyTimeBoundary 在内存中统一应用；
          // 缓存回填保留未裁剪的完整窗口，边界永远只是读取时的视图。
        },
      );
      await this.backfillCache(chatId, rawHistory);

      return this.trimByChars(
        this.injectTimeContext(this.applyTimeBoundary(rawHistory, options?.endTimeInclusive)),
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
   * 边界的本意是防「更晚到的用户输入」泄进本轮上下文（那些属于下一轮 debounce 批次）；
   * 而 assistant 消息一旦入库就是已发给候选人的既成事实。若一并裁掉，拟人化投递
   * 期间候选人插话时，下一轮会看不到上一轮刚发出的内容，把同样的话再发一遍
   * （生产案例：岗位推荐卡片被原样重发）。
   *
   * 因此边界只作用于 user 消息；边界后的 assistant 消息插到末尾 user 触发块之前，
   * 维持「窗口以本轮用户输入收尾」的下游不变量（trailingUserMessages、图片注入等）。
   * 边界内完全无消息时返回空，保持调用方原有的缓存 miss 回退语义。
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

    const listKey = buildChatHistoryCacheKey(chatId);
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

    await this.redisService.del(listKey);
    await this.redisService.rpush(listKey, ...serializedMessages);
    await this.redisService.expire(listKey, this.config.sessionTtl);
    await this.redisService.ltrim(listKey, -this.config.sessionWindowMaxMessages, -1);
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
