import { Controller, Get, Param, Query } from '@nestjs/common';
import { ChatSessionService } from './services/chat-session.service';
import { MessageProcessingService } from './services/message-processing.service';
import { AnalyticsQueryService } from '@biz/monitoring/services/analytics/analytics-query.service';

/**
 * 消息查询控制器
 * 纯委托层，不包含任何业务逻辑
 */
@Controller('analytics')
export class MessageController {
  constructor(
    private readonly chatSessionService: ChatSessionService,
    private readonly messageProcessingService: MessageProcessingService,
    private readonly analyticsQueryService: AnalyticsQueryService,
  ) {}

  @Get('chat-messages')
  async getChatMessages(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('date') date?: string,
  ) {
    return this.chatSessionService.getChatMessages(
      date,
      parseInt(page || '1', 10),
      parseInt(pageSize || '50', 10),
    );
  }

  @Get('chat-sessions')
  async getChatSessions(
    @Query('days') days?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.chatSessionService.getChatSessions({ days, startDate, endDate });
  }

  @Get('chat-daily-stats')
  async getChatDailyStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.chatSessionService.getChatDailyStats(startDate, endDate);
  }

  @Get('chat-summary-stats')
  async getChatSummaryStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.chatSessionService.getChatSummaryStats(startDate, endDate);
  }

  @Get('chat-sessions-optimized')
  async getChatSessionsOptimized(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.chatSessionService.getChatSessionsOptimized(startDate, endDate);
  }

  @Get('chat-trend')
  async getChatTrend(@Query('days') days?: string) {
    return this.analyticsQueryService.getChatTrend(days ? parseInt(days, 10) : undefined);
  }

  @Get('chat-sessions/:chatId/messages')
  async getChatSessionMessages(@Param('chatId') chatId: string) {
    return this.chatSessionService.getChatSessionMessages(chatId);
  }

  @Get('message-stats')
  async getMessageStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.messageProcessingService.getMessageStats(startDate, endDate);
  }

  @Get('slowest-messages')
  async getSlowestMessages(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messageProcessingService.getSlowestMessages(
      startDate,
      endDate,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get('message-processing-records')
  async getMessageProcessingRecords(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: 'processing' | 'success' | 'failure' | 'timeout',
    @Query('chatId') chatId?: string,
    @Query('userName') userName?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.messageProcessingService.getMessageProcessingRecords({
      startDate,
      endDate,
      status,
      chatId,
      userName,
      limit,
      offset,
    });
  }

  @Get('message-processing-records/:messageId')
  async getMessageProcessingRecordDetail(@Param('messageId') messageId: string) {
    return this.messageProcessingService.getMessageProcessingRecordById(messageId);
  }
}
