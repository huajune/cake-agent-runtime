import { Injectable } from '@nestjs/common';
import { TestExecutionRepository } from '../../repositories/test-execution.repository';
import { TestBatchRepository } from '../../repositories/test-batch.repository';
import { ConversationSnapshotRepository } from '../../repositories/conversation-snapshot.repository';
import { ConversationSourceStatus, ReviewStatus, TestType } from '../../enums/test.enum';
import type { TestExecution } from '../../entities/test-execution.entity';

@Injectable()
export class TestStatsService {
  constructor(
    private readonly executionRepository: TestExecutionRepository,
    private readonly batchRepository: TestBatchRepository,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
  ) {}

  async calculateBatchStats(batchId: string) {
    const batch = await this.batchRepository.findById(batchId);

    if (batch?.test_type === TestType.CONVERSATION) {
      const counts = await this.conversationSnapshotRepository.countByBatchIdGroupByStatus(batchId);
      const sources = await this.conversationSnapshotRepository.findByBatchId(batchId);
      const completedScores = sources
        .filter((source) => source.status === ConversationSourceStatus.COMPLETED)
        .map((source) => source.avg_similarity_score)
        .filter((score): score is number => score !== null && score !== undefined);

      const passedCount = completedScores.filter((score) => score >= 60).length;
      const failedCount = completedScores.filter((score) => score < 60).length;

      return {
        totalCases: counts.total,
        executedCount: counts.completed + counts.failed,
        passedCount,
        failedCount,
        pendingReviewCount: counts.pending + counts.running,
        passRate:
          completedScores.length > 0
            ? Math.round(
                completedScores.reduce((sum, score) => sum + score, 0) / completedScores.length,
              )
            : null,
        avgDurationMs: null,
        avgTokenUsage: null,
      };
    }

    const executions = await this.executionRepository.findByBatchIdLite(batchId);
    return this.computeStats(executions as TestExecution[]);
  }

  computeStats(executions: TestExecution[]) {
    if (executions.length === 0) {
      return {
        totalCases: 0,
        executedCount: 0,
        passedCount: 0,
        failedCount: 0,
        pendingReviewCount: 0,
        passRate: null,
        avgDurationMs: null,
        avgTokenUsage: null,
      };
    }

    const passedCount = executions.filter(
      (item) => item.review_status === ReviewStatus.PASSED,
    ).length;
    const failedCount = executions.filter(
      (item) => item.review_status === ReviewStatus.FAILED,
    ).length;
    const executedCount = executions.filter((item) => item.execution_status !== 'pending').length;

    const successDurations = executions
      .filter((item) => item.execution_status === 'success' && item.duration_ms !== null)
      .map((item) => item.duration_ms as number);
    const tokenTotals = executions
      .map((item) => (item.token_usage as { totalTokens?: number } | null)?.totalTokens)
      .filter((value): value is number => typeof value === 'number');

    return {
      totalCases: executions.length,
      executedCount,
      passedCount,
      failedCount,
      pendingReviewCount: executions.length - passedCount - failedCount,
      passRate: Math.round((passedCount / executions.length) * 100),
      avgDurationMs:
        successDurations.length > 0
          ? Math.round(
              successDurations.reduce((sum, value) => sum + value, 0) / successDurations.length,
            )
          : null,
      avgTokenUsage:
        tokenTotals.length > 0
          ? Math.round(tokenTotals.reduce((sum, value) => sum + value, 0) / tokenTotals.length)
          : null,
    };
  }

  async calculateCategoryStats(batchId: string) {
    const executions = await this.executionRepository.findByBatchIdLite(batchId);
    return this.computeCategoryStats(executions as TestExecution[]);
  }

  computeCategoryStats(executions: TestExecution[]) {
    const stats = new Map<string, { total: number; passed: number; failed: number }>();

    for (const execution of executions) {
      const category = execution.category || '未分类';
      const current = stats.get(category) || { total: 0, passed: 0, failed: 0 };
      current.total += 1;
      if (execution.review_status === ReviewStatus.PASSED) current.passed += 1;
      if (execution.review_status === ReviewStatus.FAILED) current.failed += 1;
      stats.set(category, current);
    }

    return Array.from(stats.entries()).map(([category, stat]) => ({
      category,
      total: stat.total,
      passed: stat.passed,
      failed: stat.failed,
    }));
  }

  async calculateFailureReasonStats(batchId: string) {
    const executions = await this.executionRepository.findByBatchIdLite(batchId, {
      reviewStatus: ReviewStatus.FAILED,
    });
    return this.computeFailureReasonStats(executions as TestExecution[]);
  }

  computeFailureReasonStats(executions: TestExecution[]) {
    if (executions.length === 0) {
      return [];
    }

    const counts = new Map<string, number>();
    for (const execution of executions) {
      const reason = execution.failure_reason || 'other';
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: Math.round((count / executions.length) * 100),
      }))
      .sort((a, b) => b.count - a.count);
  }
}
