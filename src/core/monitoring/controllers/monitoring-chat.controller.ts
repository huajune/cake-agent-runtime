import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ChatMessageRepository } from '@db/message';
import { MonitoringRepository } from '@db/monitoring';

/**
 * 聊天记录控制器
 * 提供聊天记录查询、会话列表、每日统计等接口
 */
@Controller('monitoring')
export class MonitoringChatController {
  private readonly logger = new Logger(MonitoringChatController.name);

  constructor(
    private readonly chatMessageRepository: ChatMessageRepository,
    private readonly monitoringRepository: MonitoringRepository,
  ) {}

  /**
   * 获取聊天记录（支持日期筛选）
   * GET /monitoring/chat-messages?page=1&pageSize=50&date=2024-01-15
   */
  @Get('chat-messages')
  async getChatMessages(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('date') date?: string,
  ) {
    const pageNum = parseInt(page || '1', 10);
    const pageSizeNum = parseInt(pageSize || '50', 10);
    const targetDate = date ? new Date(date) : new Date();

    this.logger.debug(
      `获取聊天记录: date=${targetDate.toISOString().split('T')[0]}, page=${pageNum}, pageSize=${pageSizeNum}`,
    );

    return this.chatMessageRepository.getTodayChatMessages(targetDate, pageNum, pageSizeNum);
  }

  /**
   * 获取所有会话列表
   * GET /monitoring/chat-sessions?days=7
   * GET /monitoring/chat-sessions?startDate=2024-01-01&endDate=2024-01-31
   */
  @Get('chat-sessions')
  async getChatSessions(
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = endDate ? new Date(endDate) : new Date();
      end.setHours(23, 59, 59, 999);
      this.logger.debug(`获取会话列表: ${start.toISOString()} ~ ${end.toISOString()}`);
      const sessions = await this.chatMessageRepository.getChatSessionListByDateRange(start, end);
      return { sessions };
    }

    const daysNum = parseInt(days || '1', 10);
    this.logger.debug(`获取会话列表: 最近 ${daysNum} 天`);
    const sessions = await this.chatMessageRepository.getChatSessionList(daysNum);
    return { sessions };
  }

  /**
   * 获取每日聊天统计数据
   * GET /monitoring/chat-daily-stats?startDate=2024-01-01&endDate=2024-01-31
   */
  @Get('chat-daily-stats')
  async getChatDailyStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    this.logger.debug(
      `获取每日聊天统计: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );

    return this.chatMessageRepository.getChatDailyStats(start, end);
  }

  /**
   * 获取聊天汇总统计数据
   * GET /monitoring/chat-summary-stats?startDate=2024-01-01&endDate=2024-01-31
   */
  @Get('chat-summary-stats')
  async getChatSummaryStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    this.logger.debug(
      `获取聊天汇总统计: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );

    return this.chatMessageRepository.getChatSummaryStats(start, end);
  }

  /**
   * 获取聊天会话列表（优化版，使用数据库聚合）
   * GET /monitoring/chat-sessions-optimized?startDate=2025-12-13&endDate=2025-12-16
   */
  @Get('chat-sessions-optimized')
  async getChatSessionsOptimized(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    this.logger.debug(
      `获取聊天会话列表（优化版）: ${start.toISOString().split('T')[0]} ~ ${end.toISOString().split('T')[0]}`,
    );

    return this.chatMessageRepository.getChatSessionListOptimized(start, end);
  }

  /**
   * 获取聊天趋势数据
   * GET /monitoring/chat-trend?days=7
   */
  @Get('chat-trend')
  async getChatTrend(@Query('days') days?: string) {
    const daysNum = parseInt(days || '7', 10);
    this.logger.debug(`获取聊天趋势: 最近 ${daysNum} 天`);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNum);
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
   * 获取指定会话的聊天记录
   * GET /monitoring/chat-sessions/:chatId/messages
   */
  @Get('chat-sessions/:chatId/messages')
  async getChatSessionMessages(@Param('chatId') chatId: string) {
    this.logger.debug(`获取会话消息: chatId=${chatId}`);
    const messages = await this.chatMessageRepository.getChatHistoryDetail(chatId);
    return { chatId, messages };
  }
}
