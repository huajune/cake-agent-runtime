import { Injectable, Logger } from '@nestjs/common';
import { MessageProcessingRepository } from '@db/message';

/**
 * 消息处理记录服务
 * 负责消息统计、最慢消息、处理记录查询等
 */
@Injectable()
export class MessageProcessingService {
  private readonly logger = new Logger(MessageProcessingService.name);

  constructor(private readonly messageProcessingRepository: MessageProcessingRepository) {}

  /**
   * 获取消息统计数据（聚合查询）
   */
  async getMessageStats(startTime: number, endTime: number) {
    this.logger.debug(
      `获取消息统计: ${new Date(startTime).toISOString()} ~ ${new Date(endTime).toISOString()}`,
    );
    return this.messageProcessingRepository.getMessageStats(startTime, endTime);
  }

  /**
   * 获取最慢消息 Top N
   */
  async getSlowestMessages(startTime?: number, endTime?: number, limit: number = 10) {
    this.logger.debug(`获取最慢消息 Top ${limit}`);
    return this.messageProcessingRepository.getSlowestMessages(startTime, endTime, limit);
  }

  /**
   * 获取消息处理记录列表（支持分页和筛选）
   */
  async getMessageProcessingRecords(options: Record<string, unknown>) {
    this.logger.debug(`获取消息处理记录: ${JSON.stringify(options)}`);
    const result = await this.messageProcessingRepository.getMessageProcessingRecords(options);
    return result.records;
  }

  /**
   * 获取单条消息处理记录详情
   */
  async getMessageProcessingRecordById(messageId: string) {
    this.logger.debug(`获取消息处理记录详情: ${messageId}`);
    return this.messageProcessingRepository.getMessageProcessingRecordById(messageId);
  }
}
