import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import { ChatMessageRepository } from '../repositories/chat-message.repository';
import { ChatMessageInput, ChatSessionCursor } from '../types/message.types';

/** 会话列表默认页大小，与仓储层保持一致。 */
const DEFAULT_SESSION_PAGE_SIZE = 600;
import { formatLocalDateTime } from '@infra/utils/date.util';
import {
  toStorageMessageSource,
  toStorageMessageType,
  type StorageMessageSource,
  type StorageMessageType,
} from '@enums/storage-message.enum';
import {
  buildChatHistoryCacheKey,
  type CachedChatHistoryMessage,
  serializeCachedChatHistoryMessage,
} from '@memory/short-term/chat-history-cache.util';
import { MEMORY_SESSION_TTL_DAYS_DEFAULT } from '@memory/memory.config';

/**
 * 聊天会话服务
 * 负责聊天记录查询、会话列表、统计趋势等
 */
@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    private readonly chatMessageRepository: ChatMessageRepository,
    @Optional() private readonly redisService?: RedisService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  /**
   * 获取聊天消息列表（分页）
   */
  async getChatMessages(dateStr?: string, page = 1, pageSize = 50) {
    const date = dateStr ? new Date(dateStr) : new Date();
    this.logger.debug(
      `获取聊天记录: date=${formatLocalDateTime(date)}, page=${page}, pageSize=${pageSize}`,
    );
    return this.chatMessageRepository.getTodayChatMessages(date, page, pageSize);
  }

  /**
   * 获取会话列表（按天数或日期范围）
   */
  async getChatSessions(options: {
    days?: string;
    startDate?: string;
    endDate?: string;
    limit?: string;
    search?: string;
    cursorTimestamp?: string;
    cursorChatId?: string;
  }) {
    if (options.startDate) {
      const start = this.startOfDay(options.startDate);
      const end = this.endOfDay(options.endDate);
      this.logger.debug(`获取会话列表: ${start.toISOString()} ~ ${end.toISOString()}`);
      return this.chatMessageRepository.getChatSessionPage({
        startDate: start,
        endDate: end,
        limit: this.parseLimit(options.limit),
        search: options.search,
        cursor: this.parseCursor(options.cursorTimestamp, options.cursorChatId),
      });
    }
    const days = parseInt(options.days || '1', 10);
    this.logger.debug(`获取会话列表: 最近 ${days} 天`);
    return this.chatMessageRepository.getChatSessionList(days, this.parseLimit(options.limit));
  }

  /**
   * 获取每日聊天统计
   */
  async getChatDailyStats(startDate?: string, endDate?: string) {
    const start = this.startOfDay(startDate, 30);
    const end = this.endOfDay(endDate);
    this.logger.debug(
      `获取每日聊天统计: ${formatLocalDateTime(start)} ~ ${formatLocalDateTime(end)}`,
    );
    return this.chatMessageRepository.getChatDailyStats(start, end);
  }

  /**
   * 业务口径每日趋势（永久表：daily_ops_report + ops_events），供「消息趋势」面板 / 「全部」档。
   * startDate 缺省 = 业务数据安全起点 2026-06-01（埋点齐全）；endDate 缺省 = 今天。
   */
  async getChatBusinessDailyTrend(startDate?: string, endDate?: string) {
    const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : '2026-06-01';
    const end =
      endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
        ? endDate
        : new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [trend, floor] = await Promise.all([
      this.chatMessageRepository.getChatBusinessDailyTrend(start, end),
      this.chatMessageRepository.getBusinessDataFloor(),
    ]);
    return { trend, floor, caliber: 'business' as const };
  }

  /**
   * 获取聊天汇总统计
   */
  async getChatSummaryStats(startDate?: string, endDate?: string) {
    const start = this.startOfDay(startDate, 30);
    const end = this.endOfDay(endDate);
    this.logger.debug(
      `获取聊天汇总统计: ${formatLocalDateTime(start)} ~ ${formatLocalDateTime(end)}`,
    );
    return this.chatMessageRepository.getChatSummaryStats(start, end);
  }

  /**
   * 获取聊天会话列表（优化版，数据库聚合）
   */
  async getChatSessionsOptimized(options: {
    startDate?: string;
    endDate?: string;
    limit?: string;
    search?: string;
    cursorTimestamp?: string;
    cursorChatId?: string;
  }) {
    const start = this.startOfDay(options.startDate, 30);
    const end = this.endOfDay(options.endDate);
    this.logger.debug(
      `获取聊天会话列表（优化版）: ${formatLocalDateTime(start)} ~ ${formatLocalDateTime(end)}`,
    );
    return this.chatMessageRepository.getChatSessionPage({
      startDate: start,
      endDate: end,
      limit: this.parseLimit(options.limit),
      search: options.search,
      cursor: this.parseCursor(options.cursorTimestamp, options.cursorChatId),
    });
  }

  /** 页大小解析：非法值回落默认，上限由仓储层再夹一次。 */
  private parseLimit(limit?: string): number {
    const parsed = parseInt(limit || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_PAGE_SIZE;
  }

  /** 游标需要时间戳与 chatId 成对出现，缺一即视为从头开始。 */
  private parseCursor(timestamp?: string, chatId?: string): ChatSessionCursor | undefined {
    if (!timestamp || !chatId) return undefined;
    return { timestamp, chatId };
  }

  /**
   * 按时间范围查询聊天记录（供飞书同步等外部服务使用）
   */
  async getChatMessagesByTimeRange(startTime: number, endTime: number) {
    return this.chatMessageRepository.getChatMessagesByTimeRange(startTime, endTime);
  }

  /**
   * 清理过期聊天记录
   */
  async cleanupChatMessages(retentionDays: number): Promise<number> {
    return this.chatMessageRepository.cleanupChatMessages(retentionDays);
  }

  /**
   * 保存单条聊天消息
   *
   * 返回值：DB 真正新插入了行 → true；否则（被过滤、UNIQUE 冲突、写入失败）→ false。
   * 只有真正新插入时才镜像到短期记忆缓存，消除"重复 messageId 写两遍 list"的竞态。
   */
  async saveMessage(message: ChatMessageInput): Promise<boolean> {
    const { inserted } = await this.chatMessageRepository.saveChatMessage(message);
    if (inserted) {
      await this.appendToShortTermCache(message).catch((error) => {
        this.logger.warn(`短期记忆缓存写入失败 [${message.messageId}]`, error);
      });
    }
    return inserted;
  }

  /**
   * 批量保存聊天消息
   *
   * 只把 DB 真正新插入的那部分镜像到短期记忆缓存（由 UNIQUE 约束兜底去重）。
   */
  async saveMessagesBatch(messages: ChatMessageInput[]): Promise<number> {
    const { insertedIds } = await this.chatMessageRepository.saveChatMessagesBatch(messages);
    if (insertedIds.size === 0) return 0;

    await Promise.all(
      messages
        .filter((m) => insertedIds.has(m.messageId))
        .map(async (message) => {
          await this.appendToShortTermCache(message).catch((error) => {
            this.logger.warn(`短期记忆缓存批量写入失败 [${message.messageId}]`, error);
          });
        }),
    );
    return insertedIds.size;
  }

  /**
   * 获取会话的历史消息（用于 AI 上下文）
   */
  async getChatHistory(
    chatId: string,
    limit: number,
    options?: { startTimeInclusive?: number; endTimeInclusive?: number },
  ): Promise<
    Array<{
      messageId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      source?: StorageMessageSource;
      messageType?: StorageMessageType;
      isSelf?: boolean;
      payloadSource?: string;
    }>
  > {
    return this.chatMessageRepository.getChatHistory(chatId, limit, options);
  }

  /**
   * 获取会话在指定时间边界内的消息。
   */
  async getChatHistoryInRange(
    chatId: string,
    options: { startTimeExclusive?: number; endTimeInclusive?: number; limit?: number },
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>> {
    return this.chatMessageRepository.getChatHistoryInRange(chatId, options);
  }

  /**
   * 获取指定会话的消息列表
   */
  async getChatSessionMessages(chatId: string) {
    this.logger.debug(`获取会话消息: chatId=${chatId}`);
    const messages = await this.chatMessageRepository.getChatHistoryDetail(chatId);
    return { chatId, messages };
  }

  /**
   * 更新消息的 content（按 messageId）
   *
   * DB 更新成功后直接作废该会话的短期记忆 list 缓存；下次读取 cache miss 会从 DB
   * 重新 backfill。不做「lrange → parse → 改内容 → del → 全量 rpush」的缓存内改写
   * ——作废重灌更简单且原子。
   */
  async updateMessageContent(
    messageId: string,
    content: string,
    // 视觉事实旁路：与描述同一次 update 写 visual_facts；缓存失效机制天然覆盖
    //（del → 下次 cache miss 从 DB 回填，新列随行带出）。
    visualFacts?: Record<string, unknown>,
  ): Promise<boolean> {
    const { chatId } = await this.chatMessageRepository.updateContentByMessageId(
      messageId,
      content,
      visualFacts,
    );
    if (chatId && this.redisService) {
      await this.redisService.del(buildChatHistoryCacheKey(chatId)).catch((error) => {
        this.logger.warn(`短期记忆缓存失效失败 [${messageId}/${chatId}]`, error);
      });
    }
    return chatId !== null;
  }

  /** 拉取会话内描述缺失的裸视觉消息（读时懒补写数据源）。 */
  async getBareVisualMessages(
    chatId: string,
    options?: { sinceTimestamp?: number; limit?: number },
  ): Promise<
    Array<{ messageId: string; content: string; payload: Record<string, unknown> | null }>
  > {
    return this.chatMessageRepository.getBareVisualMessagesByChat(chatId, options);
  }

  /** 拉取会话内视觉消息的结构化事实（visual-fact-structuring 消费侧读路径）。 */
  async getVisualFacts(
    chatId: string,
    options?: { sinceTimestamp?: number; limit?: number },
  ): Promise<Array<{ content: string; visualFacts: Record<string, unknown> }>> {
    return this.chatMessageRepository.getVisualFactsByChat(chatId, options);
  }

  // ==================== 内部工具方法 ====================

  private startOfDay(dateStr?: string, defaultDaysAgo = 0): Date {
    const d = dateStr ? new Date(dateStr) : new Date(Date.now() - defaultDaysAgo * 86400000);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private endOfDay(dateStr?: string): Date {
    const d = dateStr ? new Date(dateStr) : new Date();
    d.setHours(23, 59, 59, 999);
    return d;
  }

  private shouldMirrorToShortTermCache(message: ChatMessageInput): boolean {
    if (message.isRoom === true) return false;
    if (
      message.role !== 'assistant' &&
      message.contactType !== undefined &&
      message.contactType !== 1
    ) {
      return false;
    }
    return Boolean(message.chatId && message.messageId && message.content);
  }

  /**
   * 将消息追加到短期记忆 list 缓存。
   *
   * 幂等性由 DB 的 `chat_messages.message_id` UNIQUE 约束兜底：调用方只在
   * `saveChatMessage` 返回 `inserted=true` 时才调这里，所以不需要额外去重 key。
   */
  private async appendToShortTermCache(message: ChatMessageInput): Promise<void> {
    if (!this.redisService || !this.shouldMirrorToShortTermCache(message)) return;

    const listKey = buildChatHistoryCacheKey(message.chatId);
    const cacheMessage: CachedChatHistoryMessage = {
      chatId: message.chatId,
      messageId: message.messageId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      source: toStorageMessageSource(message.source),
      messageType: toStorageMessageType(message.messageType),
      isSelf: message.isSelf,
      payloadSource:
        typeof message.payload?.source === 'string' ? message.payload.source : undefined,
      provenanceVersion: 2,
    };

    await this.redisService.rpush(listKey, serializeCachedChatHistoryMessage(cacheMessage));
    await this.redisService.ltrim(listKey, -this.shortTermCacheMaxMessages, -1);
    await this.redisService.expire(listKey, this.shortTermCacheTtlSeconds);
  }

  private get shortTermCacheMaxMessages(): number {
    return parseInt(this.configService?.get('MAX_HISTORY_PER_CHAT', '120') ?? '120', 10);
  }

  private get shortTermCacheTtlSeconds(): number {
    // 同一个短期 list 缓存被本服务 append 续期、又被 MessageWindowService backfill 续期，
    // 默认值必须与 MemoryConfig.sessionTtl 一致，故共用 MEMORY_SESSION_TTL_DAYS_DEFAULT。
    const days = parseInt(
      this.configService?.get('MEMORY_SESSION_TTL_DAYS', MEMORY_SESSION_TTL_DAYS_DEFAULT) ??
        MEMORY_SESSION_TTL_DAYS_DEFAULT,
      10,
    );
    return days * 24 * 60 * 60;
  }
}
