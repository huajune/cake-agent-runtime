import { Injectable, Logger } from '@nestjs/common';
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
import { TestWriteBackService } from './test-write-back.service';
import { TestExecutionService } from './test-execution.service';
import {
  BatchStatus,
  ExecutionStatus,
  ReviewStatus,
  FeishuTestStatus,
  TestType,
  ConversationSourceStatus,
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

  constructor(
    private readonly batchRepository: TestBatchRepository,
    private readonly executionRepository: TestExecutionRepository,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
    private readonly writeBackService: TestWriteBackService,
    private readonly executionService: TestExecutionService,
  ) {
    this.logger.log('TestBatchService 初始化完成');
  }

  /**
   * 创建测试批次
   */
  async createBatch(request: CreateBatchRequestDto): Promise<TestBatch> {
    return this.batchRepository.create({
      name: request.name,
      source: request.source,
      feishuTableId: request.feishuTableId,
      testType: request.testType,
    });
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
    const stats = await this.getBatchStats(batchId);
    await this.batchRepository.updateStats(batchId, stats);
  }

  /**
   * 获取批次统计信息
   */
  async getBatchStats(batchId: string): Promise<BatchStats> {
    return this.calculateBatchStats(batchId);
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
    await this.executionRepository.updateReview(executionId, {
      reviewStatus: review.reviewStatus,
      reviewComment: review.reviewComment,
      failureReason: review.failureReason,
      testScenario: review.testScenario,
      reviewedBy: review.reviewedBy,
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
      }
    }

    if (execution.case_id && review.reviewStatus !== ReviewStatus.PENDING) {
      this.writeBackToFeishuAsync(execution, review);
    }

    this.logger.log(`更新评审状态: ${executionId} -> ${review.reviewStatus}`);
    return execution;
  }

  /**
   * 批量更新评审状态
   */
  async batchUpdateReview(executionIds: string[], review: UpdateReviewRequestDto): Promise<number> {
    const updatedExecutions = await this.executionRepository.batchUpdateReview(executionIds, {
      reviewStatus: review.reviewStatus,
      reviewComment: review.reviewComment,
      failureReason: review.failureReason,
      testScenario: review.testScenario,
      reviewedBy: review.reviewedBy,
    });

    const batchIds = new Set(
      updatedExecutions.map((e: TestExecution) => e.batch_id).filter(Boolean),
    );
    for (const batchId of batchIds) {
      await this.updateBatchStats(batchId as string);
    }

    return updatedExecutions.length;
  }

  /**
   * 批量执行测试用例
   */
  async executeBatch(
    cases: TestChatRequestDto[],
    batchId?: string,
    parallel = false,
  ): Promise<TestChatResponse[]> {
    this.logger.log(`批量执行测试: ${cases.length} 个用例, 并行: ${parallel}`);

    if (batchId) {
      await this.updateBatchStatus(batchId, BatchStatus.RUNNING);
    }

    const results: TestChatResponse[] = [];

    if (parallel) {
      const batchSize = 5;
      for (let i = 0; i < cases.length; i += batchSize) {
        const batch = cases.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((testCase) => this.executionService.executeTest({ ...testCase, batchId })),
        );
        results.push(...batchResults);
      }
    } else {
      for (const testCase of cases) {
        const result = await this.executionService.executeTest({ ...testCase, batchId });
        results.push(result);
      }
    }

    if (batchId) {
      await this.updateBatchStats(batchId);
      await this.updateBatchStatus(batchId, BatchStatus.REVIEWING);
    }

    return results;
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

    const SIMILARITY_THRESHOLD = 60;
    const completedSources = sources.filter((s) => s.status === ConversationSourceStatus.COMPLETED);
    const passedCount = completedSources.filter(
      (s) => s.avg_similarity_score !== null && s.avg_similarity_score >= SIMILARITY_THRESHOLD,
    ).length;
    const failedCount = completedSources.filter(
      (s) => s.avg_similarity_score !== null && s.avg_similarity_score < SIMILARITY_THRESHOLD,
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
      pendingReviewCount: statusCounts.pending + statusCounts.running,
      passRate: avgSimilarity,
      avgDurationMs: null,
      avgTokenUsage: null,
    };
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

  // ========== 私有方法 ==========

  private writeBackToFeishuAsync(execution: TestExecution, review: UpdateReviewRequestDto): void {
    const feishuStatus =
      review.reviewStatus === ReviewStatus.PASSED
        ? FeishuTestStatus.PASSED
        : review.reviewStatus === ReviewStatus.FAILED
          ? FeishuTestStatus.FAILED
          : FeishuTestStatus.SKIPPED;

    this.writeBackService
      .writeBackResult(
        execution.case_id!,
        feishuStatus,
        execution.batch_id || undefined,
        review.failureReason,
      )
      .then((result) => {
        if (result.success) {
          this.logger.log(`飞书回写成功: ${execution.case_id} -> ${feishuStatus}`);
        } else {
          this.logger.warn(`飞书回写失败: ${execution.case_id} - ${result.error}`);
        }
      })
      .catch((error: unknown) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`飞书回写异常: ${execution.case_id} - ${errorMsg}`);
      });
  }
}
