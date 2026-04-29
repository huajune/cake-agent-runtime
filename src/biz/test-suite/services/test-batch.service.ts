import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBatchRequestDto,
  UpdateReviewRequestDto,
  BatchStats,
  TestChatRequestDto,
  TestChatResponse,
} from '../dto/test-chat.dto';
import { TestBatchRepository } from '../repositories/test-batch.repository';
import { TestExecutionRepository } from '../repositories/test-execution.repository';
import { ConversationSnapshotRepository } from '../repositories/conversation-snapshot.repository';
import { TestBatch } from '../entities/test-batch.entity';
import { TestExecution } from '../entities/test-execution.entity';
import { TestSourceTrace } from '../types/test-debug-trace.types';
import { TestWriteBackService } from './test-write-back.service';
import { TestExecutionService } from './test-execution.service';
import {
  BadcaseDerivedStatus,
  FeishuBitableSyncService,
} from '@biz/feishu-sync/bitable-sync.service';
import {
  BatchStatus,
  ExecutionStatus,
  ReviewStatus,
  ReviewerSource,
  FeishuTestStatus,
  TestType,
  ConversationSourceStatus,
  getReviewerSourceLabel,
} from '../enums/test.enum';

/**
 * 分类统计数据
 */
export interface CategoryStats {
  category: string;
  total: number;
  passed: number;
  failed: number;
}

/**
 * 失败原因统计数据
 */
export interface FailureReasonStats {
  reason: string;
  count: number;
  percentage: number;
}

/**
 * 批次管理服务
 *
 * 职责：
 * - 创建、查询批次
 * - 更新批次状态和统计
 * - 管理批次内的执行记录
 * - 处理评审状态更新
 * - 批量执行测试用例
 */
@Injectable()
export class TestBatchService {
  private readonly logger = new Logger(TestBatchService.name);
  private readonly batchConcurrency: number;

  constructor(
    private readonly batchRepository: TestBatchRepository,
    private readonly executionRepository: TestExecutionRepository,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
    private readonly writeBackService: TestWriteBackService,
    private readonly executionService: TestExecutionService,
    private readonly configService: ConfigService,
    private readonly feishuBitableSync: FeishuBitableSyncService,
  ) {
    this.batchConcurrency = this.readPositiveInt('TEST_SUITE_BATCH_CONCURRENCY', 20, {
      min: 1,
      max: 20,
    });
    this.logger.log('TestBatchService 初始化完成');
  }

  /**
   * 创建测试批次
   */
  async createBatch(request: CreateBatchRequestDto): Promise<TestBatch> {
    return this.batchRepository.create({
      name: this.normalizeBatchName(request.name),
      source: request.source,
      feishuTableId: request.feishuTableId,
      testType: request.testType,
    });
  }

  private normalizeBatchName(name: string): string {
    const normalized = name
      .replace(/^\s*反馈验证\s*SOP\s*(?:[-—:：]\s*)?/i, '')
      .replace(/场景测试/g, '用例测试')
      .replace(/对话验证/g, '回归验证')
      .replace(/\s+/g, ' ')
      .trim();

    return normalized || name.trim();
  }

  /**
   * 获取测试批次列表（带分页）
   */
  async getBatches(
    limit = 20,
    offset = 0,
    testType?: TestType,
  ): Promise<{ data: TestBatch[]; total: number }> {
    return this.batchRepository.findMany(limit, offset, testType);
  }

  /**
   * 获取批次详情
   */
  async getBatch(batchId: string): Promise<TestBatch | null> {
    return this.batchRepository.findById(batchId);
  }

  /**
   * 获取批次的执行记录（完整版，用于详情展示）
   */
  async getBatchExecutions(
    batchId: string,
    filters?: {
      reviewStatus?: ReviewStatus;
      executionStatus?: ExecutionStatus;
      category?: string;
    },
  ): Promise<TestExecution[]> {
    return this.executionRepository.findByBatchId(batchId, filters);
  }

  /**
   * 获取批次的执行记录（列表版，用于列表展示）
   */
  async getBatchExecutionsForList(
    batchId: string,
    filters?: {
      reviewStatus?: ReviewStatus;
      executionStatus?: ExecutionStatus;
      category?: string;
    },
  ) {
    return this.executionRepository.findByBatchIdForList(batchId, filters);
  }

  /**
   * 更新批次状态
   */
  async updateBatchStatus(batchId: string, newStatus: BatchStatus): Promise<void> {
    await this.batchRepository.updateStatus(batchId, newStatus);
  }

  /**
   * 更新批次统计信息
   */
  async updateBatchStats(batchId: string): Promise<void> {
    const batch = await this.batchRepository.findById(batchId);
    if (!batch) {
      throw new Error(`批次不存在: ${batchId}`);
    }

    const stats = await this.getBatchStats(batchId);
    await this.batchRepository.updateStats(batchId, stats);

    if (batch.test_type === TestType.CONVERSATION) {
      await this.syncConversationBatchStatus(batchId, batch.status, stats);
    }
  }

  /**
   * 获取批次统计信息
   */
  async getBatchStats(batchId: string): Promise<BatchStats> {
    return this.calculateBatchStats(batchId);
  }

  /**
   * 重新执行单条用例记录
   */
  async rerunExecution(executionId: string): Promise<TestExecution> {
    const execution = await this.executionRepository.findById(executionId);
    if (!execution) {
      throw new Error(`执行记录不存在: ${executionId}`);
    }

    if (!execution.batch_id || !execution.case_id) {
      throw new Error('仅支持重跑用例测试执行记录');
    }

    const batch = await this.batchRepository.findById(execution.batch_id);
    if (batch?.status === BatchStatus.CREATED) {
      await this.updateBatchStatus(execution.batch_id, BatchStatus.RUNNING);
    }

    const testInput = this.asRecord(execution.test_input);
    const agentRequest = this.asRecord(execution.agent_request);
    const imageUrls = this.readStringArray(testInput, 'imageUrls');

    const result = await this.executionService.executeTest({
      message: this.readString(testInput, 'message') || execution.input_message || undefined,
      history: Array.isArray(testInput.history)
        ? (testInput.history as TestChatRequestDto['history'])
        : undefined,
      imageUrls,
      scenario: this.readString(testInput, 'scenario') || this.readString(agentRequest, 'scenario'),
      saveExecution: false,
      caseId: execution.case_id,
      caseName: execution.case_name || undefined,
      category: execution.category || undefined,
      expectedOutput: execution.expected_output || undefined,
      batchId: execution.batch_id,
      userId: this.readString(agentRequest, 'userId') || `scenario-test-${execution.batch_id}`,
      botUserId: this.readString(agentRequest, 'botUserId'),
      botImId: this.readString(agentRequest, 'botImId'),
      modelId: this.readString(agentRequest, 'modelId'),
      sourceTrace: execution.source_trace ?? undefined,
      memorySetup:
        this.asNonEmptyRecord(execution.memory_setup) ||
        this.asNonEmptyRecord(testInput.memorySetup) ||
        undefined,
      memoryAssertions:
        this.asNonEmptyRecord(execution.memory_assertions) ||
        this.asNonEmptyRecord(testInput.memoryAssertions) ||
        undefined,
    });

    const updated = await this.executionRepository.updateExecution(execution.id, {
      agent_request: result.request.body,
      agent_response: result.response.body,
      actual_output: result.actualOutput,
      tool_calls: result.response.toolCalls || [],
      execution_status: result.status,
      duration_ms: result.metrics.durationMs,
      token_usage: result.metrics.tokenUsage,
      error_message:
        result.status === ExecutionStatus.SUCCESS ? null : this.extractExecutionError(result),
      review_status: ReviewStatus.PENDING,
      review_comment: null,
      failure_reason: null,
      test_scenario: null,
      reviewed_by: null,
      reviewer_source: null,
      reviewed_at: null,
      execution_trace: result.trace?.executionTrace ?? null,
      memory_trace: result.trace?.memoryTrace ?? null,
    });

    await this.updateBatchStats(execution.batch_id);
    await this.updateBatchStatus(execution.batch_id, BatchStatus.REVIEWING);

    return updated;
  }

  /**
   * 获取分类统计
   */
  async getCategoryStats(batchId: string): Promise<CategoryStats[]> {
    return this.calculateCategoryStats(batchId);
  }

  /**
   * 获取失败原因统计
   */
  async getFailureReasonStats(batchId: string): Promise<FailureReasonStats[]> {
    return this.calculateFailureReasonStats(batchId);
  }

  /**
   * 更新评审状态
   */
  async updateReview(executionId: string, review: UpdateReviewRequestDto): Promise<TestExecution> {
    const reviewerSource = this.resolveReviewerSource(review);
    await this.executionRepository.updateReview(executionId, {
      reviewStatus: review.reviewStatus,
      reviewComment: review.reviewComment,
      failureReason: review.failureReason,
      testScenario: review.testScenario,
      reviewedBy: review.reviewedBy,
      reviewerSource,
    });

    const execution = await this.executionRepository.findById(executionId);
    if (!execution) {
      throw new Error(`执行记录不存在: ${executionId}`);
    }

    if (execution.batch_id) {
      await this.updateBatchStats(execution.batch_id);

      const stats = await this.getBatchStats(execution.batch_id);
      if (stats.pendingReviewCount === 0 && stats.totalCases > 0) {
        await this.updateBatchStatus(execution.batch_id, BatchStatus.COMPLETED);
        this.logger.log(`批次 ${execution.batch_id} 所有用例评审完成，状态更新为 completed`);
        await this.propagateBadcaseStatusOnCompletion(execution.batch_id);
      }
    }

    if (execution.case_id && review.reviewStatus !== ReviewStatus.PENDING) {
      await this.writeBackToFeishuAsync(execution, review);
    }

    this.logger.log(`更新评审状态: ${executionId} -> ${review.reviewStatus}`);
    return execution;
  }

  /**
   * 批量更新评审状态
   */
  async batchUpdateReview(executionIds: string[], review: UpdateReviewRequestDto): Promise<number> {
    const reviewerSource = this.resolveReviewerSource(review);
    const updatedExecutions = await this.executionRepository.batchUpdateReview(executionIds, {
      reviewStatus: review.reviewStatus,
      reviewComment: review.reviewComment,
      failureReason: review.failureReason,
      testScenario: review.testScenario,
      reviewedBy: review.reviewedBy,
      reviewerSource,
    });

    const batchIds = new Set(
      updatedExecutions.map((e: TestExecution) => e.batch_id).filter(Boolean),
    );
    for (const batchId of batchIds) {
      await this.updateBatchStats(batchId as string);

      const stats = await this.getBatchStats(batchId as string);
      if (stats.pendingReviewCount === 0 && stats.totalCases > 0) {
        await this.updateBatchStatus(batchId as string, BatchStatus.COMPLETED);
        this.logger.log(`批次 ${batchId} 所有用例评审完成，状态更新为 completed`);
        await this.propagateBadcaseStatusOnCompletion(batchId as string);
      }
    }

    if (review.reviewStatus !== ReviewStatus.PENDING) {
      for (const execution of updatedExecutions) {
        if (execution.case_id) {
          await this.writeBackToFeishuAsync(execution, review);
        }
      }
    }

    return updatedExecutions.length;
  }

  /**
   * 批量执行测试用例
   */
  async executeBatch(
    cases: TestChatRequestDto[],
    batchId?: string,
    parallel = true,
  ): Promise<TestChatResponse[]> {
    const concurrency = parallel ? Math.min(cases.length || 1, this.batchConcurrency) : 1;
    this.logger.log(`批量执行测试: ${cases.length} 个用例, 并行: ${parallel}, 并发=${concurrency}`);

    if (batchId) {
      await this.updateBatchStatus(batchId, BatchStatus.RUNNING);
    }

    const results: TestChatResponse[] = [];

    for (let i = 0; i < cases.length; i += concurrency) {
      const batch = cases.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((testCase) => this.executionService.executeTest({ ...testCase, batchId })),
      );
      results.push(...batchResults);
    }

    if (batchId) {
      await this.updateBatchStats(batchId);
      await this.updateBatchStatus(batchId, BatchStatus.REVIEWING);
    }

    return results;
  }

  private readPositiveInt(
    key: string,
    fallback: number,
    bounds: { min: number; max: number },
  ): number {
    const raw = this.configService.get<string | number>(key);
    const parsed = typeof raw === 'number' ? raw : Number(raw);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    const normalized = Math.floor(parsed);
    if (normalized < bounds.min) {
      return bounds.min;
    }
    if (normalized > bounds.max) {
      return bounds.max;
    }
    return normalized;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private asNonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
    const record = this.asRecord(value);
    return Object.keys(record).length > 0 ? record : undefined;
  }

  private readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
    const value = record[key];
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is string => typeof item === 'string' && !!item);
    return items.length > 0 ? items : undefined;
  }

  private extractExecutionError(result: TestChatResponse): string | null {
    const body = this.asRecord(result.response.body);
    const error = body.error;
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
    if (typeof error === 'object' && error && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
    return null;
  }

  // ========== 统计计算 ==========

  /**
   * 计算批次统计信息
   */
  private async calculateBatchStats(batchId: string): Promise<BatchStats> {
    const batch = await this.batchRepository.findById(batchId);

    if (batch?.test_type === TestType.CONVERSATION) {
      return this.calculateConversationBatchStats(batchId);
    }

    const executions = await this.executionRepository.findByBatchIdLite(batchId);
    return this.computeStats(executions as TestExecution[]);
  }

  /**
   * 计算回归验证批次统计
   */
  private async calculateConversationBatchStats(batchId: string): Promise<BatchStats> {
    const statusCounts =
      await this.conversationSnapshotRepository.countByBatchIdGroupByStatus(batchId);

    const sources = await this.conversationSnapshotRepository.findByBatchId(batchId);
    const turnExecutions = await this.executionRepository.findByBatchIdLite(batchId);

    const SIMILARITY_THRESHOLD = 60;
    const completedSources = sources.filter((s) => s.status === ConversationSourceStatus.COMPLETED);
    const reviewStatusBySource = new Map<
      string,
      { hasFailedReview: boolean; hasPendingReview: boolean }
    >();

    for (const execution of turnExecutions) {
      const sourceId = execution.conversation_snapshot_id;
      if (!sourceId) {
        continue;
      }

      const current = reviewStatusBySource.get(sourceId) || {
        hasFailedReview: false,
        hasPendingReview: false,
      };
      reviewStatusBySource.set(sourceId, {
        hasFailedReview: current.hasFailedReview || execution.review_status === ReviewStatus.FAILED,
        hasPendingReview:
          current.hasPendingReview || execution.review_status === ReviewStatus.PENDING,
      });
    }

    const passedCount = completedSources.filter(
      (s) =>
        !reviewStatusBySource.get(s.id)?.hasFailedReview &&
        !reviewStatusBySource.get(s.id)?.hasPendingReview &&
        s.avg_similarity_score !== null &&
        s.avg_similarity_score >= SIMILARITY_THRESHOLD,
    ).length;
    const failedCount = completedSources.filter(
      (s) =>
        reviewStatusBySource.get(s.id)?.hasFailedReview ||
        (s.avg_similarity_score !== null && s.avg_similarity_score < SIMILARITY_THRESHOLD),
    ).length;
    const pendingReviewSourceCount = completedSources.filter(
      (s) => reviewStatusBySource.get(s.id)?.hasPendingReview,
    ).length;

    const validScores = sources
      .map((s) => s.avg_similarity_score)
      .filter((s): s is number => s !== null);
    const avgSimilarity =
      validScores.length > 0
        ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length)
        : null;

    return {
      totalCases: statusCounts.total,
      executedCount: statusCounts.completed + statusCounts.failed,
      passedCount,
      failedCount,
      pendingReviewCount: statusCounts.pending + statusCounts.running + pendingReviewSourceCount,
      passRate: avgSimilarity,
      avgDurationMs: null,
      avgTokenUsage: null,
    };
  }

  private async syncConversationBatchStatus(
    batchId: string,
    currentStatus: BatchStatus,
    stats: BatchStats,
  ): Promise<void> {
    if (stats.totalCases === 0 || stats.executedCount < stats.totalCases) {
      return;
    }

    if (currentStatus === BatchStatus.CANCELLED || currentStatus === BatchStatus.COMPLETED) {
      return;
    }

    const transitionChain: BatchStatus[] = [];
    if (currentStatus === BatchStatus.CREATED) {
      transitionChain.push(BatchStatus.RUNNING, BatchStatus.REVIEWING);
    } else if (currentStatus === BatchStatus.RUNNING) {
      transitionChain.push(BatchStatus.REVIEWING);
    }

    if (stats.pendingReviewCount === 0) {
      transitionChain.push(BatchStatus.COMPLETED);
    }

    // 状态机不允许 CREATED 直接跳 COMPLETED，必须逐步迁移。
    // 中途某一步失败时（例如 DB 抖动），放弃本轮剩余 transitions；
    // 下次 sync 会基于当时最新 status 重新计算 chain 继续推进，整体仍可收敛，
    // 但运营侧需要通过日志/监控看到这种部分失败，避免静默卡在 REVIEWING。
    for (const status of transitionChain) {
      try {
        await this.batchRepository.updateStatus(batchId, status);
      } catch (error) {
        this.logger.error(
          `[syncConversationBatchStatus] 批次 ${batchId} 从 ${currentStatus} 推进到 ${status} 失败，` +
            `本轮剩余迁移被放弃（下轮 sync 会基于最新状态重试）`,
          error instanceof Error ? error.stack : String(error),
        );
        return;
      }
    }

    if (transitionChain.includes(BatchStatus.COMPLETED)) {
      await this.propagateBadcaseStatusOnCompletion(batchId);
    }
  }

  /**
   * 从执行记录数组计算统计信息（纯计算）
   */
  computeStats(executions: TestExecution[]): BatchStats {
    const totalCases = executions.length;
    const executedCount = executions.filter(
      (e) => e.execution_status !== ExecutionStatus.PENDING,
    ).length;
    const passedCount = executions.filter((e) => e.review_status === ReviewStatus.PASSED).length;
    const failedCount = executions.filter((e) => e.review_status === ReviewStatus.FAILED).length;
    const pendingReviewCount = executions.filter(
      (e) => e.review_status === ReviewStatus.PENDING,
    ).length;

    const passRate = totalCases > 0 ? (passedCount / totalCases) * 100 : null;

    const completedExecutions = executions.filter(
      (e) => e.execution_status === ExecutionStatus.SUCCESS && e.duration_ms,
    );
    const avgDurationMs =
      completedExecutions.length > 0
        ? Math.round(
            completedExecutions.reduce((sum, e) => sum + (e.duration_ms || 0), 0) /
              completedExecutions.length,
          )
        : null;

    const executionsWithTokens = executions.filter(
      (e) => (e.token_usage as { totalTokens?: number } | null)?.totalTokens,
    );
    const avgTokenUsage =
      executionsWithTokens.length > 0
        ? Math.round(
            executionsWithTokens.reduce(
              (sum, e) =>
                sum + ((e.token_usage as { totalTokens?: number } | null)?.totalTokens || 0),
              0,
            ) / executionsWithTokens.length,
          )
        : null;

    return {
      totalCases,
      executedCount,
      passedCount,
      failedCount,
      pendingReviewCount,
      passRate,
      avgDurationMs,
      avgTokenUsage,
    };
  }

  /**
   * 计算分类统计
   */
  private async calculateCategoryStats(batchId: string): Promise<CategoryStats[]> {
    const executions = await this.executionRepository.findByBatchIdLite(batchId);
    return this.computeCategoryStats(executions as TestExecution[]);
  }

  /**
   * 从执行记录数组计算分类统计（纯计算）
   */
  computeCategoryStats(executions: TestExecution[]): CategoryStats[] {
    const categoryMap = new Map<string, { total: number; passed: number; failed: number }>();

    for (const execution of executions) {
      const category = execution.category || '未分类';
      const stats = categoryMap.get(category) || { total: 0, passed: 0, failed: 0 };
      stats.total++;
      if (execution.review_status === ReviewStatus.PASSED) stats.passed++;
      if (execution.review_status === ReviewStatus.FAILED) stats.failed++;
      categoryMap.set(category, stats);
    }

    return Array.from(categoryMap.entries()).map(([category, stats]) => ({
      category,
      ...stats,
    }));
  }

  /**
   * 计算失败原因统计
   */
  private async calculateFailureReasonStats(batchId: string): Promise<FailureReasonStats[]> {
    const executions = await this.executionRepository.findByBatchIdLite(batchId, {
      reviewStatus: ReviewStatus.FAILED,
    });
    return this.computeFailureReasonStats(executions as TestExecution[]);
  }

  /**
   * 从执行记录数组计算失败原因统计（纯计算）
   */
  computeFailureReasonStats(executions: TestExecution[]): FailureReasonStats[] {
    const reasonMap = new Map<string, number>();

    for (const execution of executions) {
      const reason = execution.failure_reason || 'other';
      reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
    }

    const total = executions.length;
    return Array.from(reasonMap.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * 批次完成后，把派生用例的评审结果聚合回写到 BadCase 样本池的"状态"字段。
   *
   * 聚合规则（按 sourceTrace.badcaseRecordIds 分组）：
   * - 任一执行评审失败 → 待验证
   * - 全部通过 → 已解决
   * - 仍有 PENDING → 处理中
   *
   * 此方法仅在批次进入 COMPLETED 时触发；不阻断批次状态推进，异常仅记录日志。
   */
  async propagateBadcaseStatusOnCompletion(batchId: string): Promise<void> {
    try {
      const batch = await this.batchRepository.findById(batchId);
      if (!batch) {
        return;
      }

      const items = await this.aggregateBadcaseStatusUpdates(batch);
      if (items.length === 0) {
        return;
      }

      const result = await this.feishuBitableSync.updateBadcaseStatuses(items);
      this.logger.log(
        `[BadcaseStatus] 批次 ${batchId} 派生 BadCase 状态回写: 成功=${result.success} 失败=${result.failed} 总计=${items.length}`,
      );
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[BadcaseStatus] 批次 ${batchId} 派生 BadCase 状态回写异常: ${errorMsg}`);
    }
  }

  /**
   * 聚合批次内 sourceTrace.badcaseRecordIds → 派生 BadCase 状态。
   * 同时处理用例测试（执行级 trace）和回归验证（快照级 trace）两类批次。
   */
  private async aggregateBadcaseStatusUpdates(batch: TestBatch): Promise<
    Array<{
      recordId: string;
      status: BadcaseDerivedStatus;
      batchId: string;
      summary: string;
    }>
  > {
    const aggregates = new Map<
      string,
      { passed: number; failed: number; pending: number; total: number }
    >();

    const accumulate = (
      reviewStatus: ReviewStatus | null | undefined,
      recordIds: string[] | undefined,
    ) => {
      if (!recordIds?.length) return;
      for (const recordId of recordIds) {
        const id = recordId?.trim();
        if (!id) continue;
        const stat = aggregates.get(id) || { passed: 0, failed: 0, pending: 0, total: 0 };
        stat.total += 1;
        if (reviewStatus === ReviewStatus.PASSED) stat.passed += 1;
        else if (reviewStatus === ReviewStatus.FAILED) stat.failed += 1;
        else stat.pending += 1;
        aggregates.set(id, stat);
      }
    };

    if (batch.test_type === TestType.CONVERSATION) {
      const snapshots = await this.conversationSnapshotRepository.findByBatchId(batch.id);
      const turnExecutions = await this.executionRepository.findBatchTraceByBatchId(batch.id);
      const reviewBySnapshot = new Map<
        string,
        { hasFailed: boolean; hasPending: boolean; hasPassed: boolean }
      >();
      for (const exec of turnExecutions) {
        const sourceId = (exec as { conversation_snapshot_id?: string | null })
          .conversation_snapshot_id;
        if (!sourceId) continue;
        const cur = reviewBySnapshot.get(sourceId) || {
          hasFailed: false,
          hasPending: false,
          hasPassed: false,
        };
        if (exec.review_status === ReviewStatus.FAILED) cur.hasFailed = true;
        else if (exec.review_status === ReviewStatus.PENDING) cur.hasPending = true;
        else if (exec.review_status === ReviewStatus.PASSED) cur.hasPassed = true;
        reviewBySnapshot.set(sourceId, cur);
      }

      for (const snapshot of snapshots) {
        const trace = snapshot.source_trace as TestSourceTrace | null;
        const recordIds = trace?.badcaseRecordIds;
        if (!recordIds?.length) continue;
        const review = reviewBySnapshot.get(snapshot.id);
        const derived = review?.hasFailed
          ? ReviewStatus.FAILED
          : review?.hasPending || (!review && !snapshot.avg_similarity_score)
            ? ReviewStatus.PENDING
            : ReviewStatus.PASSED;
        accumulate(derived, recordIds);
      }
    } else {
      const executions = await this.executionRepository.findBatchTraceByBatchId(batch.id);
      for (const exec of executions) {
        const trace = exec.source_trace as TestSourceTrace | null;
        accumulate(exec.review_status, trace?.badcaseRecordIds);
      }
    }

    const items: Array<{
      recordId: string;
      status: BadcaseDerivedStatus;
      batchId: string;
      summary: string;
    }> = [];
    for (const [recordId, stat] of aggregates) {
      const status: BadcaseDerivedStatus =
        stat.failed > 0 ? '待验证' : stat.pending > 0 ? '处理中' : '已解决';
      items.push({
        recordId,
        status,
        batchId: batch.id,
        summary: `批次 ${batch.id}: 派生用例 ${stat.total} 个，通过 ${stat.passed}，失败 ${stat.failed}，待评审 ${stat.pending}`,
      });
    }
    return items;
  }

  // ========== 私有方法 ==========

  private async writeBackToFeishuAsync(
    execution: TestExecution,
    review: UpdateReviewRequestDto,
  ): Promise<void> {
    const feishuStatus =
      review.reviewStatus === ReviewStatus.PASSED
        ? FeishuTestStatus.PASSED
        : review.reviewStatus === ReviewStatus.FAILED
          ? FeishuTestStatus.FAILED
          : FeishuTestStatus.SKIPPED;
    const reviewSummary = this.buildReviewSummary(review);

    try {
      const result = await this.writeBackService.writeBackResult(
        execution.case_id!,
        feishuStatus,
        execution.batch_id || undefined,
        review.failureReason,
        reviewSummary,
      );
      if (result.success) {
        this.logger.log(`飞书回写成功: ${execution.case_id} -> ${feishuStatus}`);
      } else {
        this.logger.warn(`飞书回写失败: ${execution.case_id} - ${result.error}`);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`飞书回写异常: ${execution.case_id} - ${errorMsg}`);
    }
  }

  private buildReviewSummary(review: UpdateReviewRequestDto): string {
    const reviewerLabel = getReviewerSourceLabel(this.resolveReviewerSource(review)) ?? '人工';
    const trimmedComment = review.reviewComment?.trim();
    if (trimmedComment) {
      return trimmedComment;
    }

    if (review.reviewStatus === ReviewStatus.FAILED) {
      return review.failureReason
        ? `${reviewerLabel}评审失败：${review.failureReason}`
        : `${reviewerLabel}评审失败`;
    }

    if (review.reviewStatus === ReviewStatus.PASSED) {
      return `${reviewerLabel}评审通过`;
    }

    if (review.reviewStatus === ReviewStatus.SKIPPED) {
      return `${reviewerLabel}评审跳过`;
    }

    return `${reviewerLabel}评审待定`;
  }

  private resolveReviewerSource(
    review: Pick<UpdateReviewRequestDto, 'reviewerSource' | 'reviewedBy'>,
  ): ReviewerSource {
    if (review.reviewerSource) {
      return review.reviewerSource;
    }

    const reviewedBy = review.reviewedBy?.toLowerCase();
    if (!reviewedBy) {
      return ReviewerSource.MANUAL;
    }
    if (reviewedBy.includes('codex')) {
      return ReviewerSource.CODEX;
    }
    if (reviewedBy.includes('claude')) {
      return ReviewerSource.CLAUDE;
    }
    if (reviewedBy.includes('system')) {
      return ReviewerSource.SYSTEM;
    }
    if (reviewedBy.includes('api')) {
      return ReviewerSource.API;
    }

    return ReviewerSource.MANUAL;
  }
}
