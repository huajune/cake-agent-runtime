import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { RedisService } from '@infra/redis/redis.service';
import { MessageParser } from '@channels/wecom/message/utils/message-parser.util';
import { MemoryConfig } from '../memory.config';
import type { ShortTermMessage } from '../types/short-term.types';
import {
  buildChatHistoryCacheKey,
  parseCachedChatHistoryMessages,
  serializeCachedChatHistoryMessage,
} from '@biz/message/utils/chat-history-cache.util';

/**
 * 短期记忆服务 — 对话窗口管理
 *
 * 从 chat_messages（Supabase 永久存储）中读取最近 N 条消息，
 * 按窗口策略（条数 + 时间 + 字符上限）裁剪后输出给 Agent。
 *
 * 统一了原先分散在 MessageHistoryService.getHistory() + GeneratorAgent.trimMessages() 中的逻辑。
 */
@Injectable()
export class ShortTermService {
  private readonly logger = new Logger(ShortTermService.name);
  public lastLoadError: string | null = null;

  constructor(
    private readonly chatSession: ChatSessionService,
    private readonly config: MemoryConfig,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * 获取会话的短期记忆（裁剪后的消息窗口）
   *
   * 1. 从 chat_messages 取最近 N 条 + 时间窗口内
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
          endTimeInclusive: options?.endTimeInclusive,
        },
      );
      await this.backfillCache(chatId, rawHistory);

      return this.trimByChars(this.injectTimeContext(rawHistory));
    } catch (error) {
      this.lastLoadError = error instanceof Error ? error.message : String(error);
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
      content: MessageParser.injectTimeContext(msg.content, msg.timestamp),
      source: msg.source,
      messageType: msg.messageType,
      isSelf: msg.isSelf,
      payloadSource: msg.payloadSource,
    }));
  }

  private applyTimeBoundary<T extends { timestamp: number }>(
    messages: T[],
    endTimeInclusive?: number,
  ): T[] {
    if (!Number.isFinite(endTimeInclusive)) return messages;
    return messages.filter((message) => message.timestamp <= endTimeInclusive);
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
