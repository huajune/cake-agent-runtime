import { toErrorMessage, toErrorStack } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GeneratorToolMode } from '@agent/generator/generator.types';
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
import type {
  BadcaseEvidenceLedger,
  BadcaseEvidenceUpdate,
} from '@biz/feishu-sync/badcase-governance.types';
import { BadcaseEvidenceResolverService } from './badcase-evidence-resolver.service';
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
    private readonly badcaseEvidenceResolver: BadcaseEvidenceResolverService,
  ) {
    this.batchConcurrency = this.readPositiveInt('TEST_SUITE_BATCH_CONCURRENCY', 20, {
      min: 1,
      max: 22,
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
      toolMode:
        this.readToolMode(testInput, 'toolMode') || this.readToolMode(agentRequest, 'toolMode'),
      allowedToolNames:
        this.readToolAllowlist(testInput, 'allowedToolNames') ??
        this.readToolAllowlist(agentRequest, 'allowedToolNames'),
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

  private readToolMode(
    record: Record<string, unknown>,
    key: string,
  ): GeneratorToolMode | undefined {
    const value = this.readString(record, key);
    return value === 'scenario' || value === 'readonly' || value === 'none' ? value : undefined;
  }

  private readToolAllowlist(record: Record<string, unknown>, key: string): string[] | undefined {
    const value = record[key];
    if (!Array.isArray(value)) return undefined;
    if (!value.every((item) => typeof item === 'string')) return undefined;
    return value;
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
          toErrorStack(error),
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
   * 单批次只形成一侧证据；最终状态由飞书同步服务合并历史证据后按双门禁判定：
   * scenario 与 conversation 最近一次证据均通过，才允许写为已解决。
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

      const result = await this.feishuBitableSync.updateBadcaseStatuses(
        await this.attachEvidenceLedgers(items),
      );
      this.logger.log(
        `[BadcaseStatus] 批次 ${batchId} 派生 BadCase 状态回写: 成功=${result.success} 失败=${result.failed} 总计=${items.length}`,
      );
    } catch (error: unknown) {
      const errorMsg = toErrorMessage(error);
      this.logger.error(`[BadcaseStatus] 批次 ${batchId} 派生 BadCase 状态回写异常: ${errorMsg}`);
    }
  }

  /**
   * 从历史已完成批次重建 BadCase 证据台账。
   * 默认仅盘点；apply=true 时按批次时间从旧到新合并，确保“最近证据”判定稳定。
   */
  async backfillBadcaseEvidence(
    options: {
      apply?: boolean;
      maxBatches?: number;
    } = {},
  ): Promise<{
    apply: boolean;
    batchesScanned: number;
    batchesWithEvidence: number;
    evidenceUpdates: number;
    badcaseRecordIds: string[];
    schema?: Awaited<ReturnType<FeishuBitableSyncService['ensureBadcaseGovernanceFields']>>;
    errors: string[];
  }> {
    const apply = options.apply === true;
    const maxBatches = Math.min(Math.max(options.maxBatches || 2000, 1), 5000);
    const pageSize = 200;
    const batches: TestBatch[] = [];
    for (let offset = 0; offset < maxBatches; offset += pageSize) {
      const page = await this.batchRepository.findMany(
        Math.min(pageSize, maxBatches - offset),
        offset,
      );
      batches.push(...page.data);
      if (batches.length >= page.total || page.data.length < pageSize) break;
    }

    const completedBatches = batches
      .filter((batch) => batch.status === BatchStatus.COMPLETED)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const badcaseRecordIds = new Set<string>();
    let batchesWithEvidence = 0;
    let evidenceUpdates = 0;
    const errors: string[] = [];
    const pendingUpdates: Awaited<ReturnType<TestBatchService['aggregateBadcaseStatusUpdates']>> =
      [];
    const schema = apply
      ? await this.feishuBitableSync.ensureBadcaseGovernanceFields(true)
      : await this.feishuBitableSync.ensureBadcaseGovernanceFields(false);

    for (const batch of completedBatches) {
      try {
        const items = await this.aggregateBadcaseStatusUpdates(batch);
        if (items.length === 0) continue;
        batchesWithEvidence += 1;
        evidenceUpdates += items.length;
        items.forEach((item) => badcaseRecordIds.add(item.recordId));
        pendingUpdates.push(...items);
      } catch (error) {
        errors.push(`${batch.id}: ${toErrorMessage(error)}`);
      }
    }
    if (apply && pendingUpdates.length > 0) {
      const result = await this.feishuBitableSync.updateBadcaseStatuses(
        await this.attachEvidenceLedgers(pendingUpdates),
        { syncGovernanceDocument: false },
      );
      errors.push(...result.errors);
    }

    return {
      apply,
      batchesScanned: completedBatches.length,
      batchesWithEvidence,
      evidenceUpdates,
      badcaseRecordIds: [...badcaseRecordIds],
      schema,
      errors,
    };
  }

  /**
   * 给回写项挂上从生产库反推的双侧证据台账。
   *
   * 飞书「测试证据JSON」列在 2026-07-29 被清理，回写侧不能再依赖它做跨批次合并；
   * 生产库本来就是证据真相源，这里现查现算传下去即可。反查失败只降级为不带台账
   * （回写侧退回保守状态），不阻断状态回写本身。
   */
  private async attachEvidenceLedgers<
    T extends { recordId: string; ledger?: BadcaseEvidenceLedger },
  >(items: T[]): Promise<T[]> {
    const ledgers = await this.badcaseEvidenceResolver.resolveLedgers(
      items.map((item) => item.recordId),
    );
    if (ledgers.size === 0) return items;
    return items.map((item) => ({ ...item, ledger: ledgers.get(item.recordId) }));
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
      evidence: BadcaseEvidenceUpdate;
    }>
  > {
    const aggregates = new Map<
      string,
      {
        passed: number;
        failed: number;
        pending: number;
        total: number;
        assetIds: Set<string>;
        executionIds: Set<string>;
        reviewerSources: Set<string>;
        reviewedAt: string | null;
      }
    >();

    const accumulate = (
      reviewStatus: ReviewStatus | null | undefined,
      recordIds: string[] | undefined,
      evidence: {
        assetId?: string | null;
        executionIds?: string[];
        reviewerSources?: Array<string | null | undefined>;
        reviewedAt?: string | null;
      },
    ) => {
      if (!recordIds?.length) return;
      for (const recordId of recordIds) {
        const id = recordId?.trim();
        if (!id) continue;
        const stat = aggregates.get(id) || {
          passed: 0,
          failed: 0,
          pending: 0,
          total: 0,
          assetIds: new Set<string>(),
          executionIds: new Set<string>(),
          reviewerSources: new Set<string>(),
          reviewedAt: null,
        };
        stat.total += 1;
        if (reviewStatus === ReviewStatus.PASSED) stat.passed += 1;
        else if (reviewStatus === ReviewStatus.FAILED) stat.failed += 1;
        else stat.pending += 1;
        if (evidence.assetId) stat.assetIds.add(evidence.assetId);
        for (const executionId of evidence.executionIds || []) {
          if (executionId) stat.executionIds.add(executionId);
        }
        for (const reviewerSource of evidence.reviewerSources || []) {
          if (reviewerSource) stat.reviewerSources.add(reviewerSource);
        }
        if (
          evidence.reviewedAt &&
          (!stat.reviewedAt ||
            new Date(evidence.reviewedAt).getTime() > new Date(stat.reviewedAt).getTime())
        ) {
          stat.reviewedAt = evidence.reviewedAt;
        }
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
        else if (exec.review_status === ReviewStatus.PASSED) cur.hasPassed = true;
        else cur.hasPending = true;
        reviewBySnapshot.set(sourceId, cur);
      }

      for (const snapshot of snapshots) {
        const trace = snapshot.source_trace as TestSourceTrace | null;
        const recordIds = trace?.badcaseRecordIds;
        if (!recordIds?.length) continue;
        const review = reviewBySnapshot.get(snapshot.id);
        const derived = review?.hasFailed
          ? ReviewStatus.FAILED
          : review?.hasPending || !review
            ? ReviewStatus.PENDING
            : ReviewStatus.PASSED;
        const snapshotExecutions = turnExecutions.filter(
          (execution) => execution.conversation_snapshot_id === snapshot.id,
        );
        accumulate(derived, recordIds, {
          assetId: snapshot.conversation_id || snapshot.id,
          executionIds: snapshotExecutions.map((execution) => execution.id),
          reviewerSources: snapshotExecutions.map((execution) => execution.reviewer_source),
          reviewedAt:
            snapshotExecutions
              .map((execution) => execution.reviewed_at)
              .filter((value): value is string => !!value)
              .sort()
              .at(-1) || null,
        });
      }
    } else {
      const executions = await this.executionRepository.findBatchTraceByBatchId(batch.id);
      for (const exec of executions) {
        const trace = exec.source_trace as TestSourceTrace | null;
        accumulate(exec.review_status, trace?.badcaseRecordIds, {
          assetId: exec.case_id,
          executionIds: [exec.id],
          reviewerSources: [exec.reviewer_source],
          reviewedAt: exec.reviewed_at,
        });
      }
    }

    const items: Array<{
      recordId: string;
      status: BadcaseDerivedStatus;
      batchId: string;
      summary: string;
      evidence: BadcaseEvidenceUpdate;
    }> = [];
    for (const [recordId, stat] of aggregates) {
      const status: BadcaseDerivedStatus =
        stat.failed > 0 ? '待验证' : stat.pending > 0 ? '处理中' : '已解决';
      items.push({
        recordId,
        status,
        batchId: batch.id,
        summary: `批次 ${batch.id}: 派生用例 ${stat.total} 个，通过 ${stat.passed}，失败 ${stat.failed}，待评审 ${stat.pending}`,
        evidence: {
          kind: batch.test_type === TestType.CONVERSATION ? 'conversation' : 'scenario',
          batchId: batch.id,
          assetIds: [...stat.assetIds],
          executionIds: [...stat.executionIds],
          reviewStatus: stat.failed > 0 ? 'failed' : stat.pending > 0 ? 'pending' : 'passed',
          reviewerSources: [...stat.reviewerSources],
          reviewedAt: stat.reviewedAt,
        },
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
      const errorMsg = toErrorMessage(error);
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
