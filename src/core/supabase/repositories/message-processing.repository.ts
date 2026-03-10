import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { SupabaseService } from '../supabase.service';

/**
 * 消息处理记录输入
 */
export interface MessageProcessingRecordInput {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  receivedAt: number;
  messagePreview?: string;
  replyPreview?: string;
  replySegments?: number;
  status: 'processing' | 'success' | 'failure';
  error?: string;
  scenario?: string;
  totalDuration?: number;
  queueDuration?: number;
  prepDuration?: number;
  aiStartAt?: number;
  aiEndAt?: number;
  aiDuration?: number;
  sendDuration?: number;
  tools?: string[];
  tokenUsage?: number;
  isFallback?: boolean;
  fallbackSuccess?: boolean;
  agentInvocation?: unknown;
  batchId?: string;
  isPrimary?: boolean;
}

/**
 * 消息处理记录数据库格式
 */
interface MessageProcessingDbRecord {
  message_id: string;
  chat_id: string;
  user_id?: string;
  user_name?: string;
  manager_name?: string;
  received_at: string;
  message_preview?: string;
  reply_preview?: string;
  reply_segments?: number;
  status: string;
  error?: string;
  scenario?: string;
  total_duration?: number;
  queue_duration?: number;
  prep_duration?: number;
  ai_start_at?: number;
  ai_end_at?: number;
  ai_duration?: number;
  send_duration?: number;
  tools?: string[];
  token_usage?: number;
  is_fallback?: boolean;
  fallback_success?: boolean;
  agent_invocation?: unknown;
  batch_id?: string;
  is_primary?: boolean;
}

/**
 * 消息处理记录 Repository
 *
 * 负责管理 message_processing_records 表：
 * - 保存消息处理记录
 * - 查询消息处理统计
 * - 获取最慢消息
 */
@Injectable()
export class MessageProcessingRepository extends BaseRepository {
  protected readonly tableName = 'message_processing_records';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // ==================== 消息处理记录 ====================

  /**
   * 保存消息处理记录
   */
  async saveMessageProcessingRecord(record: MessageProcessingRecordInput): Promise<boolean> {
    if (!this.isAvailable()) {
      this.logger.warn('[消息处理记录] Supabase 未初始化，跳过保存');
      return false;
    }

    try {
      const dbRecord = this.toDbRecord(record);

      await this.insert(dbRecord, {
        onConflict: 'message_id',
        resolution: 'merge-duplicates',
        returnMinimal: true,
      });

      this.logger.debug(`[消息处理记录] 已保存: ${record.messageId}`);
      return true;
    } catch (error) {
      this.logger.error(`[消息处理记录] 保存失败 [${record.messageId}]:`, error);
      return false;
    }
  }

  /**
   * 获取最慢的消息（按 AI 处理耗时降序）
   */
  async getSlowestMessages(
    startTime?: number,
    endTime?: number,
    limit: number = 10,
  ): Promise<MessageProcessingRecordInput[]> {
    if (!this.isAvailable()) {
      this.logger.warn('[最慢消息] Supabase 未初始化');
      return [];
    }

    try {
      const params: Record<string, string> = {
        status: 'eq.success',
        ai_duration: 'gt.0',
        order: 'ai_duration.desc',
        limit: String(limit),
      };

      const andConditions: string[] = [];
      if (startTime) {
        andConditions.push(`received_at.gte.${new Date(startTime).toISOString()}`);
      }
      if (endTime) {
        andConditions.push(`received_at.lte.${new Date(endTime).toISOString()}`);
      }
      if (andConditions.length > 0) {
        params['and'] = `(${andConditions.join(',')})`;
      }

      const results = await this.select<MessageProcessingDbRecord>(params);

      return results.map((r) => this.fromDbRecord(r));
    } catch (error) {
      this.logger.error('[最慢消息] 查询失败:', error);
      return [];
    }
  }

  /**
   * 获取指定时间范围内的消息处理记录
   */
  async getMessageProcessingRecords(options: {
    startTime?: number;
    endTime?: number;
    status?: 'processing' | 'success' | 'failure';
    limit?: number;
    offset?: number;
  }): Promise<{
    records: MessageProcessingRecordInput[];
    total: number;
  }> {
    if (!this.isAvailable()) {
      return { records: [], total: 0 };
    }

    try {
      const params: Record<string, string> = {
        order: 'received_at.desc',
      };

      const andConditions: string[] = [];
      if (options.startTime) {
        andConditions.push(`received_at.gte.${new Date(options.startTime).toISOString()}`);
      }
      if (options.endTime) {
        andConditions.push(`received_at.lte.${new Date(options.endTime).toISOString()}`);
      }
      if (andConditions.length > 0) {
        params['and'] = `(${andConditions.join(',')})`;
      }
      if (options.status) {
        params.status = `eq.${options.status}`;
      }
      if (options.limit) {
        params.limit = String(options.limit);
      }
      if (options.offset) {
        params.offset = String(options.offset);
      }

      const results = await this.select<MessageProcessingDbRecord>(params);
      const total = await this.count(params);

      return {
        records: results.map((r) => this.fromDbRecord(r)),
        total,
      };
    } catch (error) {
      this.logger.error('获取消息处理记录失败:', error);
      return { records: [], total: 0 };
    }
  }

  /**
   * 根据消息ID获取单条消息处理记录详情
   */
  async getMessageProcessingRecordById(
    messageId: string,
  ): Promise<MessageProcessingRecordInput | null> {
    if (!this.isAvailable()) {
      this.logger.warn('[消息处理记录] Supabase 未初始化，跳过查询');
      return null;
    }

    try {
      const results = await this.select<MessageProcessingDbRecord>({
        message_id: `eq.${messageId}`,
        limit: '1',
      });

      if (results.length === 0) {
        this.logger.debug(`[消息处理记录] 未找到 messageId: ${messageId}`);
        return null;
      }

      return this.fromDbRecord(results[0]);
    } catch (error) {
      this.logger.error(`[消息处理记录] 查询详情失败 (messageId: ${messageId}):`, error);
      return null;
    }
  }

  // ==================== 清理方法 ====================

  /**
   * 清理过期消息处理记录
   * 调用数据库 RPC 函数 cleanup_message_processing_records
   * @param retentionDays 保留天数
   * @returns 删除的记录数
   */
  async cleanupMessageProcessingRecords(retentionDays: number): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const result = await this.rpc<Array<{ cleanup_message_processing_records: string }>>(
        'cleanup_message_processing_records',
        { days_to_keep: retentionDays },
      );

      const deletedCount = parseInt(result?.[0]?.cleanup_message_processing_records ?? '0', 10);
      return deletedCount;
    } catch (error) {
      this.logger.error(`[消息处理记录] 清理失败:`, error);
      throw error;
    }
  }

  /**
   * 将过期的 agent_invocation 字段置为 NULL（释放 TOAST 空间）
   * @param daysOld 超过多少天的记录将被清理
   * @returns 更新的记录数
   */
  async nullAgentInvocations(daysOld: number = 7): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const result = await this.rpc<Array<{ null_agent_invocation: string }>>(
        'null_agent_invocation',
        { p_days_old: daysOld },
      );

      const updatedCount = parseInt(result?.[0]?.null_agent_invocation ?? '0', 10);
      return updatedCount;
    } catch (error) {
      this.logger.error(`[消息处理记录] NULL agent_invocation 失败:`, error);
      throw error;
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 转换为数据库记录格式
   */
  private toDbRecord(record: MessageProcessingRecordInput): MessageProcessingDbRecord {
    return {
      message_id: record.messageId,
      chat_id: record.chatId,
      user_id: record.userId,
      user_name: record.userName,
      manager_name: record.managerName,
      received_at: new Date(record.receivedAt).toISOString(),
      message_preview: record.messagePreview,
      reply_preview: record.replyPreview,
      reply_segments: record.replySegments,
      status: record.status,
      error: record.error,
      scenario: record.scenario,
      total_duration: record.totalDuration,
      queue_duration: record.queueDuration,
      prep_duration: record.prepDuration,
      ai_start_at: record.aiStartAt,
      ai_end_at: record.aiEndAt,
      ai_duration: record.aiDuration,
      send_duration: record.sendDuration,
      tools: record.tools,
      token_usage: record.tokenUsage,
      is_fallback: record.isFallback,
      fallback_success: record.fallbackSuccess,
      agent_invocation: record.agentInvocation,
      batch_id: record.batchId,
      is_primary: record.isPrimary,
    };
  }

  /**
   * 从数据库记录格式转换
   */
  private fromDbRecord(record: MessageProcessingDbRecord): MessageProcessingRecordInput {
    return {
      messageId: record.message_id,
      chatId: record.chat_id,
      userId: record.user_id,
      userName: record.user_name,
      managerName: record.manager_name,
      receivedAt: new Date(record.received_at).getTime(),
      messagePreview: record.message_preview,
      replyPreview: record.reply_preview,
      replySegments: record.reply_segments,
      status: record.status as 'processing' | 'success' | 'failure',
      error: record.error,
      scenario: record.scenario,
      totalDuration: record.total_duration,
      queueDuration: record.queue_duration,
      prepDuration: record.prep_duration,
      aiStartAt: record.ai_start_at,
      aiEndAt: record.ai_end_at,
      aiDuration: record.ai_duration,
      sendDuration: record.send_duration,
      tools: record.tools,
      tokenUsage: record.token_usage,
      isFallback: record.is_fallback,
      fallbackSuccess: record.fallback_success,
      agentInvocation: record.agent_invocation,
      batchId: record.batch_id,
      isPrimary: record.is_primary,
    };
  }
}
