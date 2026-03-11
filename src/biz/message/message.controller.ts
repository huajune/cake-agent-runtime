import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ChatSessionService } from './chat-session.service';
import { MessageProcessingService } from './message-processing.service';

/**
 * 消息查询控制器
 * 提供聊天记录、会话、消息处理记录等查询接口，供 Dashboard 前端调用
 */
@Controller('analytics')
export class MessageController {
  private readonly logger = new Logger(MessageController.name);

  constructor(
    private readonly chatSessionService: ChatSessionService,
    private readonly messageProcessingService: MessageProcessingService,
  ) {}

  // ==================== 聊天会话 ====================

  /**
   * 获取聊天记录（支持日期筛选）
   * GET /analytics/chat-messages?page=1&pageSize=50&date=2024-01-15
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
    return this.chatSessionService.getChatMessages(targetDate, pageNum, pageSizeNum);
  }

  /**
   * 获取所有会话列表
   * GET /analytics/chat-sessions?days=7
   * GET /analytics/chat-sessions?startDate=2024-01-01&endDate=2024-01-31
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
      return this.chatSessionService.getChatSessionsByDateRange(start, end);
    }
    return this.chatSessionService.getChatSessionsByDays(parseInt(days || '1', 10));
  }

  /**
   * 获取每日聊天统计数据
   * GET /analytics/chat-daily-stats?startDate=2024-01-01&endDate=2024-01-31
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
    return this.chatSessionService.getChatDailyStats(start, end);
  }

  /**
   * 获取聊天汇总统计数据
   * GET /analytics/chat-summary-stats?startDate=2024-01-01&endDate=2024-01-31
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
    return this.chatSessionService.getChatSummaryStats(start, end);
  }

  /**
   * 获取聊天会话列表（优化版，使用数据库聚合）
   * GET /analytics/chat-sessions-optimized?startDate=2025-12-13&endDate=2025-12-16
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
    return this.chatSessionService.getChatSessionsOptimized(start, end);
  }

  /**
   * 获取聊天趋势数据
   * GET /analytics/chat-trend?days=7
   */
  @Get('chat-trend')
  async getChatTrend(@Query('days') days?: string) {
    return this.chatSessionService.getChatTrend(parseInt(days || '7', 10));
  }

  /**
   * 获取指定会话的聊天记录
   * GET /analytics/chat-sessions/:chatId/messages
   */
  @Get('chat-sessions/:chatId/messages')
  async getChatSessionMessages(@Param('chatId') chatId: string) {
    return this.chatSessionService.getChatSessionMessages(chatId);
  }

  // ==================== 消息处理记录 ====================

  /**
   * 获取消息统计数据（聚合查询）
   * GET /analytics/message-stats?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   */
  @Get('message-stats')
  async getMessageStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const startTime = startDate
      ? (() => {
          const d = new Date(startDate);
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        })()
      : Date.now() - 24 * 60 * 60 * 1000;
    const endTime = endDate
      ? (() => {
          const d = new Date(endDate);
          d.setHours(23, 59, 59, 999);
          return d.getTime();
        })()
      : Date.now();
    return this.messageProcessingService.getMessageStats(startTime, endTime);
  }

  /**
   * 获取最慢消息 Top N
   * GET /analytics/slowest-messages?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&limit=10
   */
  @Get('slowest-messages')
  async getSlowestMessages(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const startTime = startDate
      ? (() => {
          const d = new Date(startDate);
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        })()
      : undefined;
    const endTime = endDate
      ? (() => {
          const d = new Date(endDate);
          d.setHours(23, 59, 59, 999);
          return d.getTime();
        })()
      : undefined;
    return this.messageProcessingService.getSlowestMessages(startTime, endTime, limitNum);
  }

  /**
   * 获取消息处理记录（支持分页和排序）
   * GET /analytics/message-processing-records
   */
  @Get('message-processing-records')
  async getMessageProcessingRecords(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: 'processing' | 'success' | 'failure',
    @Query('chatId') chatId?: string,
    @Query('userName') userName?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const options: Record<string, unknown> = {};
    if (startDate) {
      const d = new Date(startDate);
      d.setHours(0, 0, 0, 0);
      options.startDate = d;
    }
    if (endDate) {
      const d = new Date(endDate);
      d.setHours(23, 59, 59, 999);
      options.endDate = d;
    }
    if (status) options.status = status;
    if (chatId) options.chatId = chatId;
    if (userName) options.userName = userName;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);
    return this.messageProcessingService.getMessageProcessingRecords(options);
  }

  /**
   * 获取单条消息处理记录详情
   * GET /analytics/message-processing-records/:messageId
   */
  @Get('message-processing-records/:messageId')
  async getMessageProcessingRecordDetail(@Param('messageId') messageId: string) {
    return this.messageProcessingService.getMessageProcessingRecordById(messageId);
  }
}
