import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import { ConversationSourceStatus } from '../enums/test.enum';
import { ConversationSnapshotRecord } from '../entities/conversation-snapshot.entity';
import {
  CreateConversationSourceData,
  UpdateConversationSourceData,
  ConversationSourceFilters,
} from '../types/test-suite.types';

/**
 * 对话快照 Repository
 *
 * 职责：
 * - 封装 test_conversation_snapshots 表的 CRUD 操作
 * - 管理对话快照的状态更新
 * - 查询对话快照记录
 */
@Injectable()
export class ConversationSnapshotRepository extends BaseRepository {
  protected readonly tableName = 'test_conversation_snapshots';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
    this.logger.log('ConversationSnapshotRepository 初始化完成');
  }

  // ==================== 基础 CRUD ====================

  /**
   * 创建对话快照记录
   */
  async create(data: CreateConversationSourceData): Promise<ConversationSnapshotRecord> {
    return this.insert<ConversationSnapshotRecord>({
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
   * 根据ID查询对话快照
   */
  async findById(id: string): Promise<ConversationSnapshotRecord | null> {
    return this.selectOne<ConversationSnapshotRecord>('*', (q) => q.eq('id', id));
  }

  /**
   * 根据批次ID查询对话快照列表
   */
  async findByBatchId(
    batchId: string,
    filters?: ConversationSourceFilters,
  ): Promise<ConversationSnapshotRecord[]> {
    return this.select<ConversationSnapshotRecord>('*', (q) => {
      let r = q.eq('batch_id', batchId).order('created_at');
      if (filters?.status) {
        r = r.eq('status', filters.status);
      }
      return r;
    });
  }

  /**
   * 根据批次ID查询对话快照列表（分页）
   */
  async findByBatchIdPaginated(
    batchId: string,
    page: number,
    pageSize: number,
    filters?: ConversationSourceFilters,
  ): Promise<{ data: ConversationSnapshotRecord[]; total: number }> {
    // 查询数据
    const data = await this.select<ConversationSnapshotRecord>('*', (q) => {
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
   * 根据对话ID查询对话快照
   */
  async findByConversationId(conversationId: string): Promise<ConversationSnapshotRecord | null> {
    return this.selectOne<ConversationSnapshotRecord>('*', (q) =>
      q.eq('conversation_id', conversationId),
    );
  }

  // ==================== 更新操作 ====================

  /**
   * 更新对话快照
   */
  async updateSource(
    id: string,
    data: UpdateConversationSourceData,
  ): Promise<ConversationSnapshotRecord> {
    const updateData: Record<string, unknown> = {};

    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    if (data.totalTurns !== undefined) {
      updateData.total_turns = data.totalTurns;
    }

    if (data.avgSimilarityScore !== undefined) {
      updateData.avg_similarity_score = data.avgSimilarityScore;
    }

    if (data.minSimilarityScore !== undefined) {
      updateData.min_similarity_score = data.minSimilarityScore;
    }

    const results = await this.update<ConversationSnapshotRecord>(updateData, (q) =>
      q.eq('id', id),
    );

    return results[0];
  }

  /**
   * 更新对话快照状态
   */
  async updateStatus(id: string, status: ConversationSourceStatus): Promise<void> {
    await this.update({ status }, (q) => q.eq('id', id));
  }

  // ==================== 统计操作 ====================

  /**
   * 统计批次中对话快照的状态分布
   */
  async countByBatchIdGroupByStatus(batchId: string): Promise<{
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  }> {
    const records = await this.select<ConversationSnapshotRecord>('status', (q) =>
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
    const records = await this.select<ConversationSnapshotRecord>('avg_similarity_score', (q) =>
      q.eq('batch_id', batchId).eq('status', ConversationSourceStatus.COMPLETED),
    );

    const validScores = records
      .map((r) => r.avg_similarity_score)
      .filter((s): s is number => s !== null);

    if (validScores.length === 0) return null;

    return Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length);
  }
}
