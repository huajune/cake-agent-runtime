import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { MonitoringService } from '../monitoring.service';
import { MessageProcessingRepository } from '@db/message';

/**
 * 消息处理记录控制器
 * 提供消息统计、最慢消息、处理记录查询等接口
 */
@Controller('monitoring')
export class MonitoringMessagesController {
  private readonly logger = new Logger(MonitoringMessagesController.name);

  constructor(
    private readonly monitoringService: MonitoringService,
    private readonly messageProcessingRepository: MessageProcessingRepository,
  ) {}

  /**
   * 获取消息统计数据（聚合查询）
   * GET /monitoring/message-stats?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   */
  @Get('message-stats')
  async getMessageStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const options: { startDate?: Date; endDate?: Date } = {};

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      options.startDate = start;
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      options.endDate = end;
    }

    this.logger.debug(`获取消息统计: ${JSON.stringify(options)}`);

    return this.monitoringService.getMessageStatsAsync(
      options.startDate?.getTime() || Date.now() - 24 * 60 * 60 * 1000,
      options.endDate?.getTime() || Date.now(),
    );
  }

  /**
   * 获取最慢消息 Top N
   * GET /monitoring/slowest-messages?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&limit=10
   */
  @Get('slowest-messages')
  async getSlowestMessages(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = limit ? parseInt(limit, 10) : 10;
    let startTime: number | undefined;
    let endTime: number | undefined;

    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      startTime = start.getTime();
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      endTime = end.getTime();
    }

    this.logger.debug(`获取最慢消息 Top ${limitNum}`);
    return this.messageProcessingRepository.getSlowestMessages(startTime, endTime, limitNum);
  }

  /**
   * 获取消息处理记录（支持分页和排序）
   * GET /monitoring/message-processing-records
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
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      options.startDate = start;
    }

    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      options.endDate = end;
    }

    if (status) options.status = status;
    if (chatId) options.chatId = chatId;
    if (userName) options.userName = userName;
    if (limit) options.limit = parseInt(limit, 10);
    if (offset) options.offset = parseInt(offset, 10);

    this.logger.debug(`获取消息处理记录: ${JSON.stringify(options)}`);
    const result = await this.messageProcessingRepository.getMessageProcessingRecords(options);
    return result.records;
  }

  /**
   * 获取单条消息处理记录详情
   * GET /monitoring/message-processing-records/:messageId
   */
  @Get('message-processing-records/:messageId')
  async getMessageProcessingRecordDetail(@Param('messageId') messageId: string) {
    this.logger.debug(`获取消息处理记录详情: ${messageId}`);
    return this.messageProcessingRepository.getMessageProcessingRecordById(messageId);
  }
}
