import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
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
  private validationTitleColumnAvailable: boolean | null = null;

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
    this.logger.log('ConversationSnapshotRepository 初始化完成');
  }

  // ==================== 基础 CRUD ====================

  /**
   * 创建对话快照记录
   */
  async create(data: CreateConversationSourceData): Promise<ConversationSnapshotRecord> {
    const payload = this.buildCreatePayload(
      data,
      this.validationTitleColumnAvailable !== false && data.validationTitle !== undefined,
    );

    return this.insertCreatePayload(payload) as Promise<ConversationSnapshotRecord>;
  }

  private buildCreatePayload(
    data: CreateConversationSourceData,
    includeValidationTitle: boolean,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      batch_id: data.batchId,
      feishu_record_id: data.feishuRecordId,
      conversation_id: data.conversationId,
      participant_name: data.participantName || null,
      full_conversation: data.fullConversation,
      raw_text: data.rawText || null,
      total_turns: data.totalTurns,
      status: ConversationSourceStatus.PENDING,
      source_trace: data.sourceTrace || null,
      memory_setup: data.memorySetup || null,
      memory_assertions: data.memoryAssertions || null,
    };

    if (includeValidationTitle) {
      payload.validation_title = data.validationTitle || null;
    }

    return payload;
  }

  private async insertCreatePayload(
    payload: Record<string, unknown>,
  ): Promise<ConversationSnapshotRecord | null> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} 插入`);
      return null;
    }

    const insertPayload = async (candidate: Record<string, unknown>) => {
      const query = this.getClient().from(this.tableName).insert(candidate);
      return query.select();
    };

    try {
      const optionalColumns = new Set([
        'validation_title',
        'source_trace',
        'memory_setup',
        'memory_assertions',
      ]);
      const candidate = { ...payload };
      const maxAttempts = optionalColumns.size + 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const attemptPayload = { ...candidate };
        const { data: result, error } = await insertPayload(attemptPayload);
        if (!error) {
          this.validationTitleColumnAvailable =
            candidate.validation_title === undefined ? false : true;
          return (result as ConversationSnapshotRecord[])?.[0] ?? null;
        }

        const missingColumn = this.extractMissingOptionalColumn(error, optionalColumns);
        if (missingColumn) {
          if (!Object.prototype.hasOwnProperty.call(candidate, missingColumn)) {
            this.handleError('INSERT', {
              code: 'SCHEMA_FALLBACK_REPEAT',
              message: `${this.tableName} schema fallback repeated missing optional column ${missingColumn}`,
            });
            return null;
          }
          delete candidate[missingColumn];
          optionalColumns.delete(missingColumn);
          if (missingColumn === 'validation_title') {
            this.validationTitleColumnAvailable = false;
          }
          this.logger.warn(
            `${this.tableName} 缺少 ${missingColumn} 列，已按旧 schema 跳过该列；请确认 traceability 迁移已应用`,
          );
          continue;
        }

        if (this.isConflictError(error)) {
          this.logger.debug(`${this.tableName} 记录已存在，跳过插入`);
          return null;
        }
        this.handleError('INSERT', error);
        return null;
      }

      this.handleError('INSERT', {
        code: 'SCHEMA_FALLBACK_LIMIT',
        message: `${this.tableName} schema fallback exceeded ${maxAttempts} attempts`,
      });
      return null;
    } catch (error) {
      if (this.isConflictError(error)) {
        this.logger.debug(`${this.tableName} 记录已存在，跳过插入`);
        return null;
      }
      this.handleError('INSERT', error);
      return null;
    }
  }

  private extractMissingOptionalColumn(
    error: unknown,
    optionalColumns: Set<string>,
  ): string | null {
    const pgError = error as { code?: string; message?: string };
    if (pgError.code !== 'PGRST204') return null;
    const message = pgError.message || '';
    for (const column of optionalColumns) {
      if (message.includes(`'${column}' column`) || message.includes(` ${column} `)) {
        return column;
      }
    }
    return null;
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
