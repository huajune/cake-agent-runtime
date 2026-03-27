import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatMessageRepository } from '../repositories/chat-message.repository';
import { ChatMessageInput } from '../types/message.types';
import { formatLocalDateTime } from '@infra/utils/date.util';
import { MonitoringRecordRepository } from '@biz/monitoring/repositories/record.repository';

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
   */
  async saveMessage(message: ChatMessageInput): Promise<boolean> {
    return this.chatMessageRepository.saveChatMessage(message);
  }

  /**
   * 批量保存聊天消息
   */
  async saveMessagesBatch(messages: ChatMessageInput[]): Promise<number> {
    return this.chatMessageRepository.saveChatMessagesBatch(messages);
  }

  /**
   * 获取会话的历史消息（用于 AI 上下文）
   */
  async getChatHistory(
    chatId: string,
    limit: number,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>> {
    return this.chatMessageRepository.getChatHistory(chatId, limit);
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
   */
  async updateMessageContent(messageId: string, content: string): Promise<boolean> {
    return this.chatMessageRepository.updateContentByMessageId(messageId, content);
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
}
