import { Injectable, Logger } from '@nestjs/common';
import { ChatMessageRepository } from '@db/message';
import { MonitoringRepository } from '@db/monitoring';

/**
 * 聊天会话服务
 * 负责聊天记录查询、会话列表、统计趋势等
 */
@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    private readonly chatMessageRepository: ChatMessageRepository,
    private readonly monitoringRepository: MonitoringRepository,
  ) {}

  /**
   * 获取聊天消息列表（分页）
   */
  async getChatMessages(date: Date, page: number, pageSize: number) {
    this.logger.debug(
      `获取聊天记录: date=${date.toISOString().split('T')[0]}, page=${page}, pageSize=${pageSize}`,
    );
    return this.chatMessageRepository.getTodayChatMessages(date, page, pageSize);
  }

  /**
   * 获取会话列表（按天数）
   */
  async getChatSessionsByDays(days: number) {
    this.logger.debug(`获取会话列表: 最近 ${days} 天`);
    const sessions = await this.chatMessageRepository.getChatSessionList(days);
    return { sessions };
  }

  /**
   * 获取会话列表（按日期范围）
   */
  async getChatSessionsByDateRange(start: Date, end: Date) {
    this.logger.debug(`获取会话列表: ${start.toISOString()} ~ ${end.toISOString()}`);
    const sessions = await this.chatMessageRepository.getChatSessionListByDateRange(start, end);
    return { sessions };
  }

  /**
   * 获取每日聊天统计
   */
  async getChatDailyStats(start: Date, end: Date) {
    this.logger.debug(
      `获取每日聊天统计: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );
    return this.chatMessageRepository.getChatDailyStats(start, end);
  }

  /**
   * 获取聊天汇总统计
   */
  async getChatSummaryStats(start: Date, end: Date) {
    this.logger.debug(
      `获取聊天汇总统计: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );
    return this.chatMessageRepository.getChatSummaryStats(start, end);
  }

  /**
   * 获取聊天会话列表（优化版，数据库聚合）
   */
  async getChatSessionsOptimized(start: Date, end: Date) {
    this.logger.debug(
      `获取聊天会话列表（优化版）: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );
    return this.chatMessageRepository.getChatSessionListOptimized(start, end);
  }

  /**
   * 获取聊天趋势（小时级）
   */
  async getChatTrend(days: number) {
    this.logger.debug(`获取聊天趋势: 最近 ${days} 天`);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const endDate = new Date();
    const trend = await this.monitoringRepository.getDashboardHourlyTrend(startDate, endDate);
    return trend.map((item) => ({
      hour: item.hour,
      message_count: item.messageCount,
      active_users: item.uniqueUsers,
      active_chats: 0,
    }));
  }

  /**
   * 获取指定会话的消息列表
   */
  async getChatSessionMessages(chatId: string) {
    this.logger.debug(`获取会话消息: chatId=${chatId}`);
    const messages = await this.chatMessageRepository.getChatHistoryDetail(chatId);
    return { chatId, messages };
  }
}
