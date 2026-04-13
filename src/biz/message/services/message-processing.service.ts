import { Injectable, Logger } from '@nestjs/common';
import { MessageProcessingRepository } from '../repositories/message-processing.repository';
import { MessageProcessingRecordInput } from '../types/message.types';

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
  async getMessageStats(startDate?: string, endDate?: string) {
    const startTime = this.toStartTimestamp(startDate, 1);
    const endTime = this.toEndTimestamp(endDate);
    this.logger.debug(
      `获取消息统计: ${new Date(startTime).toISOString()} ~ ${new Date(endTime).toISOString()}`,
    );
    return this.messageProcessingRepository.getMessageStats(startTime, endTime);
  }

  /**
   * 获取最慢消息 Top N
   */
  async getSlowestMessages(startDate?: string, endDate?: string, limit = 10) {
    const startTime = startDate ? this.toStartTimestamp(startDate) : undefined;
    const endTime = endDate ? this.toEndTimestamp(endDate) : undefined;
    this.logger.debug(`获取最慢消息 Top ${limit}`);
    return this.messageProcessingRepository.getSlowestMessages(startTime, endTime, limit);
  }

  /**
   * 获取消息处理记录列表（支持分页和筛选）
   */
  async getMessageProcessingRecords(query: {
    startDate?: string;
    endDate?: string;
    status?: 'processing' | 'success' | 'failure' | 'timeout';
    chatId?: string;
    userName?: string;
    limit?: string;
    offset?: string;
  }) {
    const options: Record<string, unknown> = {};
    if (query.startDate) {
      const d = new Date(query.startDate);
      d.setHours(0, 0, 0, 0);
      options.startDate = d;
    }
    if (query.endDate) {
      const d = new Date(query.endDate);
      d.setHours(23, 59, 59, 999);
      options.endDate = d;
    }
    if (query.status) options.status = query.status;
    if (query.chatId) options.chatId = query.chatId;
    if (query.userName) options.userName = query.userName;
    if (query.limit) options.limit = parseInt(query.limit, 10);
    if (query.offset) options.offset = parseInt(query.offset, 10);

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

  /**
   * 按时间戳获取消息统计（供监控服务使用）
   */
  async getMessageStatsByTimestamps(startTime: number, endTime: number) {
    return this.messageProcessingRepository.getMessageStats(startTime, endTime);
  }

  /**
   * 获取指定日期范围内的活跃用户
   */
  async getActiveUsers(startDate: Date, endDate: Date) {
    return this.messageProcessingRepository.getActiveUsers(startDate, endDate);
  }

  /**
   * 获取每日用户统计
   */
  async getDailyUserStats(startDate: Date, endDate: Date) {
    return this.messageProcessingRepository.getDailyUserStats(startDate, endDate);
  }

  /**
   * 按时间戳查询消息记录（轻量版，供 Dashboard 使用）
   */
  async getRecordsByTimeRange(startTime: number, endTime: number, limit?: number) {
    return this.messageProcessingRepository.getRecordsByTimeRange(startTime, endTime, limit);
  }

  /**
   * 按时间戳选项查询消息处理记录（供内部服务使用）
   */
  async getRecordsByTimestamps(options: {
    startTime?: number;
    endTime?: number;
    status?: 'processing' | 'success' | 'failure' | 'timeout';
    limit?: number;
    offset?: number;
  }) {
    return this.messageProcessingRepository.getMessageProcessingRecords(options);
  }

  /**
   * 保存消息处理记录（供追踪服务使用）
   */
  async saveRecord(record: MessageProcessingRecordInput): Promise<boolean> {
    return this.messageProcessingRepository.saveMessageProcessingRecord(record);
  }

  /**
   * 按 message_id 直接更新状态（pendingRecords 丢失时的降级路径）
   */
  async updateStatusByMessageId(
    messageId: string,
    updates: Parameters<MessageProcessingRepository['updateStatusByMessageId']>[1],
  ): Promise<boolean> {
    return this.messageProcessingRepository.updateStatusByMessageId(messageId, updates);
  }

  /**
   * 将过期的 agent_invocation 字段置为 NULL（释放 TOAST 空间）
   */
  async nullAgentInvocations(daysOld: number): Promise<number> {
    return this.messageProcessingRepository.nullAgentInvocations(daysOld);
  }

  /**
   * 清空所有消息处理记录（仅供测试/维护使用）
   */
  async clearAllRecords(): Promise<void> {
    return this.messageProcessingRepository.clearAllRecords();
  }

  /**
   * 清理过期消息处理记录
   */
  async cleanupRecords(retentionDays: number): Promise<number> {
    return this.messageProcessingRepository.cleanupMessageProcessingRecords(retentionDays);
  }

  /**
   * 将卡住的 processing 记录标记为 timeout
   */
  async timeoutStuckRecords(stuckMinutes = 30): Promise<number> {
    return this.messageProcessingRepository.timeoutStuckRecords(stuckMinutes);
  }

  // ==================== 内部工具方法 ====================

  private toStartTimestamp(dateStr?: string, defaultDaysAgo = 0): number {
    if (dateStr) {
      const d = new Date(dateStr);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    return Date.now() - defaultDaysAgo * 86400000;
  }

  private toEndTimestamp(dateStr?: string): number {
    if (dateStr) {
      const d = new Date(dateStr);
      d.setHours(23, 59, 59, 999);
      return d.getTime();
    }
    return Date.now();
  }
}
