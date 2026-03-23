import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { BatchStatus, BatchSource, TestType } from '../enums/test.enum';
import { TestBatch } from '../entities/test-batch.entity';
import { CreateBatchData, BatchStatsData } from '../types/test-suite.types';

/**
 * 测试批次 Repository
 *
 * 职责：
 * - 封装批次表的 CRUD 操作
 * - 管理批次状态转换（状态机）
 * - 更新批次统计信息
 *
 * 继承 BaseRepository，复用通用 CRUD 方法
 */
@Injectable()
export class TestBatchRepository extends BaseRepository {
  protected readonly tableName = 'test_batches';

  /**
   * 批次状态有效转换规则
   *
   * created   → running, cancelled
   * running   → reviewing, cancelled
   * reviewing → completed, cancelled
   * completed → (终态)
   * cancelled → (终态)
   */
  private readonly VALID_STATUS_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
    [BatchStatus.CREATED]: [BatchStatus.RUNNING, BatchStatus.CANCELLED],
    [BatchStatus.RUNNING]: [BatchStatus.REVIEWING, BatchStatus.CANCELLED],
    [BatchStatus.REVIEWING]: [BatchStatus.COMPLETED, BatchStatus.CANCELLED],
    [BatchStatus.COMPLETED]: [], // 终态
    [BatchStatus.CANCELLED]: [], // 终态
  };

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
    this.logger.log('TestBatchRepository 初始化完成');
  }

  // ==================== 基础 CRUD ====================

  /**
   * 创建测试批次
   */
  async create(data: CreateBatchData): Promise<TestBatch> {
    const batch = await this.insert<TestBatch>({
      name: data.name,
      source: data.source || BatchSource.MANUAL,
      feishu_table_id: data.feishuTableId || null,
      status: BatchStatus.CREATED,
      test_type: data.testType || TestType.SCENARIO,
    });

    this.logger.log(`创建测试批次: ${batch.id} - ${batch.name}, testType: ${batch.test_type}`);
    return batch;
  }

  /**
   * 获取批次列表（带总数）
   *
   * @param limit 每页数量
   * @param offset 偏移量
   * @param testType 测试类型过滤：scenario-用例测试，conversation-回归验证
   */
  async findMany(
    limit = 20,
    offset = 0,
    testType?: TestType,
  ): Promise<{ data: TestBatch[]; total: number }> {
    if (!this.isAvailable()) return { data: [], total: 0 };
    try {
      let query = this.getClient()
        .from(this.tableName)
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (testType) {
        query = query.eq('test_type', testType);
      }
      const { data, error, count } = await query;
      if (error) {
        this.handleError('SELECT', error);
        return { data: [], total: 0 };
      }
      return { data: (data as TestBatch[]) ?? [], total: count ?? 0 };
    } catch (error) {
      this.handleError('SELECT', error);
      return { data: [], total: 0 };
    }
  }

  /**
   * 获取批次详情
   */
  async findById(batchId: string): Promise<TestBatch | null> {
    return this.selectOne<TestBatch>('*', (q) => q.eq('id', batchId));
  }

  // ==================== 状态管理 ====================

  /**
   * 更新批次状态（带状态机验证）
   *
   * @throws Error 如果状态转换非法
   */
  async updateStatus(batchId: string, newStatus: BatchStatus): Promise<void> {
    // 1. 获取当前状态
    const batch = await this.findById(batchId);
    if (!batch) {
      throw new Error(`批次 ${batchId} 不存在`);
    }

    const currentStatus = batch.status;

    // 2. 验证状态转换是否合法
    const validTransitions = this.VALID_STATUS_TRANSITIONS[currentStatus] || [];
    if (!validTransitions.includes(newStatus)) {
      // 如果状态相同，静默忽略（幂等操作）
      if (currentStatus === newStatus) {
        return;
      }
      this.logger.warn(
        `[Batch] 非法状态转换: ${batchId} 从 ${currentStatus} → ${newStatus}（允许: ${validTransitions.join(', ') || '无'}）`,
      );
      throw new Error(
        `非法状态转换: 从 ${currentStatus} 到 ${newStatus}（允许: ${validTransitions.join(', ') || '无'}）`,
      );
    }

    // 3. 更新状态
    const updateData: Record<string, unknown> = { status: newStatus };
    if (newStatus === BatchStatus.COMPLETED || newStatus === BatchStatus.CANCELLED) {
      updateData.completed_at = new Date().toISOString();
    }

    await this.update(updateData, (q) => q.eq('id', batchId));
    this.logger.log(`[Batch] 状态更新: ${batchId} ${currentStatus} → ${newStatus}`);
  }

  // ==================== 统计更新 ====================

  /**
   * 更新批次统计信息
   */
  async updateStats(batchId: string, stats: BatchStatsData): Promise<void> {
    await this.update(
      {
        total_cases: stats.totalCases,
        executed_count: stats.executedCount,
        passed_count: stats.passedCount,
        failed_count: stats.failedCount,
        pending_review_count: stats.pendingReviewCount,
        pass_rate: stats.passRate,
        avg_duration_ms: stats.avgDurationMs,
        avg_token_usage: stats.avgTokenUsage,
      },
      (q) => q.eq('id', batchId),
    );
  }
}
