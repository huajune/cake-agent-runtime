import { Injectable, Logger } from '@nestjs/common';
import { TestExecutionRepository } from '../../repositories/test-execution.repository';
import { TestBatchRepository } from '../../repositories/test-batch.repository';
import { ConversationSourceRepository } from '../../repositories/conversation-source.repository';
import { TestExecution } from '../../entities/test-execution.entity';
import {
  ExecutionStatus,
  ReviewStatus,
  TestType,
  ConversationSourceStatus,
} from '../../enums/test.enum';

/**
 * 批次统计数据
 */
export interface BatchStats {
  totalCases: number;
  executedCount: number;
  passedCount: number;
  failedCount: number;
  pendingReviewCount: number;
  passRate: number | null;
  avgDurationMs: number | null;
  avgTokenUsage: number | null;
}

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
 * 测试统计服务
 *
 * 职责：
 * - 计算批次统计信息（通过率、平均耗时、Token 使用量等）
 * - 计算分类统计
 * - 计算失败原因统计
 *
 * 从 AgentTestService 中抽取，遵循单一职责原则
 */
@Injectable()
export class TestStatsService {
  private readonly logger = new Logger(TestStatsService.name);

  constructor(
    private readonly executionRepository: TestExecutionRepository,
    private readonly batchRepository: TestBatchRepository,
    private readonly conversationSourceRepository: ConversationSourceRepository,
  ) {
    this.logger.log('TestStatsService 初始化完成');
  }

  /**
   * 计算批次统计信息
   * 根据批次类型选择不同的统计方式：
   * - scenario: 从 TestExecution 表统计（用例测试）
   * - conversation: 从 ConversationSource 表统计（回归验证）
   */
  async calculateBatchStats(batchId: string): Promise<BatchStats> {
    // 获取批次信息以确定测试类型
    const batch = await this.batchRepository.findById(batchId);

    // 根据测试类型选择不同的统计方式
    if (batch?.test_type === TestType.CONVERSATION) {
      return this.calculateConversationBatchStats(batchId);
    }

    // 默认：用例测试统计
    const executions = await this.executionRepository.findByBatchIdLite(batchId);
    return this.computeStats(executions as TestExecution[]);
  }

  /**
   * 计算回归验证批次统计
   * 从 ConversationSource 表统计
   */
  private async calculateConversationBatchStats(batchId: string): Promise<BatchStats> {
    const statusCounts =
      await this.conversationSourceRepository.countByBatchIdGroupByStatus(batchId);

    // 获取所有对话源以计算通过率
    const sources = await this.conversationSourceRepository.findByBatchId(batchId);

    // 计算通过率（相似度 >= 60 视为通过）
    const SIMILARITY_THRESHOLD = 60;
    const completedSources = sources.filter((s) => s.status === ConversationSourceStatus.COMPLETED);
    const passedCount = completedSources.filter(
      (s) => s.avg_similarity_score !== null && s.avg_similarity_score >= SIMILARITY_THRESHOLD,
    ).length;
    const failedCount = completedSources.filter(
      (s) => s.avg_similarity_score !== null && s.avg_similarity_score < SIMILARITY_THRESHOLD,
    ).length;

    // 计算平均相似度（作为通过率）
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
      passRate: avgSimilarity, // 回归验证使用平均相似度作为通过率
      avgDurationMs: null,
      avgTokenUsage: null,
    };
  }

  /**
   * 从执行记录数组计算统计信息（纯计算，不查数据库）
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

    // 通过率 = 通过数 / 总用例数（反映整体完成度）
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
   * 使用轻量版查询，只获取统计所需字段，提升性能
   */
  async calculateCategoryStats(batchId: string): Promise<CategoryStats[]> {
    const executions = await this.executionRepository.findByBatchIdLite(batchId);
    return this.computeCategoryStats(executions as TestExecution[]);
  }

  /**
   * 从执行记录数组计算分类统计（纯计算，不查数据库）
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
   * 使用轻量版查询，只获取统计所需字段，提升性能
   */
  async calculateFailureReasonStats(batchId: string): Promise<FailureReasonStats[]> {
    const executions = await this.executionRepository.findByBatchIdLite(batchId, {
      reviewStatus: ReviewStatus.FAILED,
    });
    return this.computeFailureReasonStats(executions as TestExecution[]);
  }

  /**
   * 从执行记录数组计算失败原因统计（纯计算，不查数据库）
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
}
