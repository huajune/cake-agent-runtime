import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import { ConversationSourceStatus } from '@test-suite/enums';
import {
  ConversationSourceRecord,
  CreateConversationSourceData,
  UpdateConversationSourceData,
  ConversationSourceFilters,
} from '../types';

/**
 * 对话源 Repository
 *
 * 职责：
 * - 封装 conversation_test_sources 表的 CRUD 操作
 * - 管理对话源的状态更新
 * - 查询对话源记录
 */
@Injectable()
export class ConversationSourceRepository extends BaseRepository {
  protected readonly tableName = 'conversation_test_sources';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
    this.logger.log('ConversationSourceRepository 初始化完成');
  }

  // ==================== 基础 CRUD ====================

  /**
   * 创建对话源记录
   */
  async create(data: CreateConversationSourceData): Promise<ConversationSourceRecord> {
    return this.insert<ConversationSourceRecord>({
      batch_id: data.batchId,
      feishu_record_id: data.feishuRecordId,
      conversation_id: data.conversationId,
      participant_name: data.participantName || null,
      full_conversation: data.fullConversation,
      raw_text: data.rawText || null,
      total_turns: data.totalTurns,
      status: ConversationSourceStatus.PENDING,
    });
  }

  /**
   * 根据ID查询对话源
   */
  async findById(id: string): Promise<ConversationSourceRecord | null> {
    return this.selectOne<ConversationSourceRecord>('*', (q) => q.eq('id', id));
  }

  /**
   * 根据批次ID查询对话源列表
   */
  async findByBatchId(
    batchId: string,
    filters?: ConversationSourceFilters,
  ): Promise<ConversationSourceRecord[]> {
    return this.select<ConversationSourceRecord>('*', (q) => {
      let r = q.eq('batch_id', batchId).order('created_at');
      if (filters?.status) {
        r = r.eq('status', filters.status);
      }
      return r;
    });
  }

  /**
   * 根据批次ID查询对话源列表（分页）
   */
  async findByBatchIdPaginated(
    batchId: string,
    page: number,
    pageSize: number,
    filters?: ConversationSourceFilters,
  ): Promise<{ data: ConversationSourceRecord[]; total: number }> {
    // 查询数据
    const data = await this.select<ConversationSourceRecord>('*', (q) => {
      let r = q
        .eq('batch_id', batchId)
        .order('created_at')
        .range((page - 1) * pageSize, page * pageSize - 1);
      if (filters?.status) {
        r = r.eq('status', filters.status);
      }
      return r;
    });

    // 查询总数
    const total = await this.count((q) => {
      let r = q.eq('batch_id', batchId);
      if (filters?.status) {
        r = r.eq('status', filters.status);
      }
      return r;
    });

    return {
      data,
      total,
    };
  }

  /**
   * 根据对话ID查询对话源
   */
  async findByConversationId(conversationId: string): Promise<ConversationSourceRecord | null> {
    return this.selectOne<ConversationSourceRecord>('*', (q) =>
      q.eq('conversation_id', conversationId),
    );
  }

  // ==================== 更新操作 ====================

  /**
   * 更新对话源
   */
  async updateSource(
    id: string,
    data: UpdateConversationSourceData,
  ): Promise<ConversationSourceRecord> {
    const updateData: Record<string, unknown> = {};

    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    if (data.avg_similarity_score !== undefined) {
      updateData.avg_similarity_score = data.avg_similarity_score;
    }

    if (data.min_similarity_score !== undefined) {
      updateData.min_similarity_score = data.min_similarity_score;
    }

    const results = await this.update<ConversationSourceRecord>(updateData, (q) => q.eq('id', id));

    return results[0];
  }

  /**
   * 更新对话源状态
   */
  async updateStatus(id: string, status: ConversationSourceStatus): Promise<void> {
    await this.update({ status }, (q) => q.eq('id', id));
  }

  // ==================== 统计操作 ====================

  /**
   * 统计批次中对话源的状态分布
   */
  async countByBatchIdGroupByStatus(batchId: string): Promise<{
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  }> {
    const records = await this.select<ConversationSourceRecord>('status', (q) =>
      q.eq('batch_id', batchId),
    );

    return {
      total: records.length,
      pending: records.filter((r) => r.status === ConversationSourceStatus.PENDING).length,
      running: records.filter((r) => r.status === ConversationSourceStatus.RUNNING).length,
      completed: records.filter((r) => r.status === ConversationSourceStatus.COMPLETED).length,
      failed: records.filter((r) => r.status === ConversationSourceStatus.FAILED).length,
    };
  }

  /**
   * 计算批次的平均相似度
   */
  async calculateBatchAvgSimilarity(batchId: string): Promise<number | null> {
    const records = await this.select<ConversationSourceRecord>('avg_similarity_score', (q) =>
      q.eq('batch_id', batchId).eq('status', ConversationSourceStatus.COMPLETED),
    );

    const validScores = records
      .map((r) => r.avg_similarity_score)
      .filter((s): s is number => s !== null);

    if (validScores.length === 0) return null;

    return Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length);
  }
}
