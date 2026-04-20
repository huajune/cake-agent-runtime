import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import { ChatMessageRepository } from '../repositories/chat-message.repository';
import { ChatMessageInput } from '../types/message.types';
import { formatLocalDateTime } from '@infra/utils/date.util';
import { MonitoringRecordRepository } from '@biz/monitoring/repositories/record.repository';
import {
  buildChatHistoryCacheKey,
  type CachedChatHistoryMessage,
  serializeCachedChatHistoryMessage,
} from '../utils/chat-history-cache.util';

/**
 * 聊天会话服务
 * 负责聊天记录查询、会话列表、统计趋势等
 */
@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    private readonly chatMessageRepository: ChatMessageRepository,
    @Optional() private readonly monitoringRecordRepository?: MonitoringRecordRepository,
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
  async getChatSessions(options: { days?: string; startDate?: string; endDate?: string }) {
    if (options.startDate) {
      const start = this.startOfDay(options.startDate);
      const end = this.endOfDay(options.endDate);
      this.logger.debug(`获取会话列表: ${start.toISOString()} ~ ${end.toISOString()}`);
      const sessions = await this.chatMessageRepository.getChatSessionListByDateRange(start, end);
      return { sessions };
    }
    const days = parseInt(options.days || '1', 10);
    this.logger.debug(`获取会话列表: 最近 ${days} 天`);
    const sessions = await this.chatMessageRepository.getChatSessionList(days);
    return { sessions };
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
  async getChatSessionsOptimized(startDate?: string, endDate?: string) {
    const start = this.startOfDay(startDate, 30);
    const end = this.endOfDay(endDate);
    this.logger.debug(
      `获取聊天会话列表（优化版）: ${formatLocalDateTime(start)} ~ ${formatLocalDateTime(end)}`,
    );
    return this.chatMessageRepository.getChatSessionListByDateRange(start, end);
  }

  /**
   * 获取聊天趋势（兼容旧监控接口）
   */
  async getChatTrend(days: number = 7): Promise<
    Array<{
      hour: string;
      message_count: number;
      active_users: number;
      active_chats: number;
    }>
  > {
    if (!this.monitoringRecordRepository) {
      return [];
    }

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    const records = await this.monitoringRecordRepository.getDashboardHourlyTrend(
      startDate,
      endDate,
    );

    return records.map((item) => ({
      hour: item.hour,
      message_count: item.messageCount,
      active_users: item.uniqueUsers,
      active_chats: 0,
    }));
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
    options?: { startTimeInclusive?: number },
  ): Promise<
    Array<{ messageId: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
  > {
    return this.chatMessageRepository.getChatHistory(chatId, limit, options);
  }

  /**
   * 获取会话在指定时间边界内的消息。
   */
  async getChatHistoryInRange(
    chatId: string,
    options: { startTimeExclusive?: number; endTimeInclusive?: number },
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
   * 重新 backfill。这比原先的「lrange → parse → 改内容 → del → 全量 rpush」更简单且原子。
   */
  async updateMessageContent(messageId: string, content: string): Promise<boolean> {
    const { chatId } = await this.chatMessageRepository.updateContentByMessageId(
      messageId,
      content,
    );
    if (chatId && this.redisService) {
      await this.redisService.del(buildChatHistoryCacheKey(chatId)).catch((error) => {
        this.logger.warn(`短期记忆缓存失效失败 [${messageId}/${chatId}]`, error);
      });
    }
    return chatId !== null;
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
    };

    await this.redisService.rpush(listKey, serializeCachedChatHistoryMessage(cacheMessage));
    await this.redisService.ltrim(listKey, -this.shortTermCacheMaxMessages, -1);
    await this.redisService.expire(listKey, this.shortTermCacheTtlSeconds);
  }

  private get shortTermCacheMaxMessages(): number {
    return parseInt(this.configService?.get('MAX_HISTORY_PER_CHAT', '60') ?? '60', 10);
  }

  private get shortTermCacheTtlSeconds(): number {
    const days = parseInt(this.configService?.get('MEMORY_SESSION_TTL_DAYS', '1') ?? '1', 10);
    return days * 24 * 60 * 60;
  }
}
