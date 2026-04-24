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
 * 统一了原先分散在 MessageHistoryService.getHistory() + AgentRunnerService.trimMessages() 中的逻辑。
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
      const cachedHistory = this.applyTimeBoundary(
        await this.getCachedHistory(chatId),
        options?.endTimeInclusive,
      );
      if (cachedHistory.length > 0) {
        return this.trimByChars(this.injectTimeContext(cachedHistory));
      }

      const rawHistory = await this.chatSession.getChatHistory(
        chatId,
        this.config.sessionWindowMaxMessages,
        {
          startTimeInclusive: Date.now() - this.config.sessionTtl * 1000,
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
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>,
  ): ShortTermMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: MessageParser.injectTimeContext(msg.content, msg.timestamp),
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
  ): Promise<
    Array<{ messageId: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
  > {
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
