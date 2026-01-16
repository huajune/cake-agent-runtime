import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase/repositories/base.repository';
import { SupabaseService } from '@core/supabase';
import { ConversationSourceStatus } from '../enums';

/**
 * 对话源记录（数据库格式）
 */
export interface ConversationSourceRecord {
  id: string;
  batch_id: string;
  feishu_record_id: string;
  conversation_id: string;
  participant_name: string | null;
  full_conversation: unknown;
  raw_text: string | null;
  total_turns: number;
  avg_similarity_score: number | null;
  min_similarity_score: number | null;
  status: ConversationSourceStatus;
  created_at: string;
  updated_at: string;
}

/**
 * 创建对话源数据
 */
export interface CreateConversationSourceData {
  batchId: string;
  feishuRecordId: string;
  conversationId: string;
  participantName?: string;
  fullConversation: unknown;
  rawText?: string;
  totalTurns: number;
}

/**
 * 更新对话源数据
 */
export interface UpdateConversationSourceData {
  status?: ConversationSourceStatus;
  total_turns?: number;
  avg_similarity_score?: number | null;
  min_similarity_score?: number | null;
}

/**
 * 对话源筛选条件
 */
export interface ConversationSourceFilters {
  status?: ConversationSourceStatus;
}

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
    return this.selectOne<ConversationSourceRecord>({ id: `eq.${id}` });
  }

  /**
   * 根据批次ID查询对话源列表
   */
  async findByBatchId(
    batchId: string,
    filters?: ConversationSourceFilters,
  ): Promise<ConversationSourceRecord[]> {
    const params: Record<string, string> = {
      batch_id: `eq.${batchId}`,
      order: 'created_at.asc',
    };

    if (filters?.status) {
      params.status = `eq.${filters.status}`;
    }

    return this.select<ConversationSourceRecord>(params);
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
    const params: Record<string, string> = {
      batch_id: `eq.${batchId}`,
      order: 'created_at.asc',
      limit: String(pageSize),
      offset: String((page - 1) * pageSize),
    };

    if (filters?.status) {
      params.status = `eq.${filters.status}`;
    }

    // 查询数据
    const data = await this.select<ConversationSourceRecord>(params);

    // 查询总数
    const countParams: Record<string, string> = {
      batch_id: `eq.${batchId}`,
      select: 'count',
    };

    if (filters?.status) {
      countParams.status = `eq.${filters.status}`;
    }

    const countResult = await this.count(countParams);

    return {
      data,
      total: countResult,
    };
  }

  /**
   * 根据对话ID查询对话源
   */
  async findByConversationId(conversationId: string): Promise<ConversationSourceRecord | null> {
    return this.selectOne<ConversationSourceRecord>({
      conversation_id: `eq.${conversationId}`,
    });
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

    const results = await this.update<ConversationSourceRecord>({ id: `eq.${id}` }, updateData);

    return results[0];
  }

  /**
   * 更新对话源状态
   */
  async updateStatus(id: string, status: ConversationSourceStatus): Promise<void> {
    await this.update({ id: `eq.${id}` }, { status });
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
    const records = await this.select<ConversationSourceRecord>({
      batch_id: `eq.${batchId}`,
      select: 'status',
    });

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
    const records = await this.select<ConversationSourceRecord>({
      batch_id: `eq.${batchId}`,
      status: `eq.${ConversationSourceStatus.COMPLETED}`,
      select: 'avg_similarity_score',
    });

    const validScores = records
      .map((r) => r.avg_similarity_score)
      .filter((s): s is number => s !== null);

    if (validScores.length === 0) return null;

    return Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length);
  }
}
