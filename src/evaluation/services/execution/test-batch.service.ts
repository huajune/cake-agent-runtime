import { Injectable } from '@nestjs/common';
import { TestBatchRepository } from '../../repositories/test-batch.repository';
import { TestExecutionRepository } from '../../repositories/test-execution.repository';
import { TestStatsService } from './test-stats.service';
import { TestWriteBackService } from '../feishu/test-write-back.service';
import {
  BatchStatus,
  FeishuTestStatus,
  ReviewStatus,
} from '../../enums/test.enum';

@Injectable()
export class TestBatchService {
  constructor(
    private readonly batchRepository: TestBatchRepository,
    private readonly executionRepository: TestExecutionRepository,
    private readonly statsService: TestStatsService,
    private readonly writeBackService: TestWriteBackService,
  ) {}

  async createBatch(request: Record<string, unknown>) {
    return this.batchRepository.create(request as never);
  }

  async getBatches(limit = 20, offset = 0, testType?: string) {
    return this.batchRepository.findMany(limit, offset, testType as never);
  }

  async getBatch(batchId: string) {
    return this.batchRepository.findById(batchId);
  }

  async getBatchExecutions(batchId: string, filters?: Record<string, unknown>) {
    return this.executionRepository.findByBatchId(batchId, filters);
  }

  async getBatchExecutionsForList(batchId: string, filters?: Record<string, unknown>) {
    return this.executionRepository.findByBatchIdForList(batchId, filters);
  }

  async updateBatchStatus(batchId: string, status: BatchStatus) {
    await this.batchRepository.updateStatus(batchId, status);
  }

  async updateBatchStats(batchId: string) {
    const stats = await this.statsService.calculateBatchStats(batchId);
    await this.batchRepository.updateStats(batchId, stats);
  }

  async getBatchStats(batchId: string) {
    return this.statsService.calculateBatchStats(batchId);
  }

  async getCategoryStats(batchId: string) {
    return this.statsService.calculateCategoryStats(batchId);
  }

  async getFailureReasonStats(batchId: string) {
    return this.statsService.calculateFailureReasonStats(batchId);
  }

  async updateReview(executionId: string, review: Record<string, unknown>) {
    await this.executionRepository.updateReview(executionId, {
      reviewStatus: review.reviewStatus as ReviewStatus,
      reviewComment: review.reviewComment as string | undefined,
      failureReason: review.failureReason as string | undefined,
      testScenario: review.testScenario as string | undefined,
      reviewedBy: review.reviewedBy as string | undefined,
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
      }
    }

    if (execution.case_id && review.reviewStatus !== ReviewStatus.PENDING) {
      setImmediate(async () => {
        const testStatus =
          review.reviewStatus === ReviewStatus.FAILED
            ? FeishuTestStatus.FAILED
            : review.reviewStatus === ReviewStatus.SKIPPED
              ? FeishuTestStatus.SKIPPED
              : FeishuTestStatus.PASSED;

        await this.writeBackService.writeBackResult(
          execution.case_id,
          testStatus,
          execution.batch_id || undefined,
          review.failureReason as string | undefined,
        );
      });
    }

    return execution;
  }

  async batchUpdateReview(executionIds: string[], review: Record<string, unknown>) {
    const updatedExecutions = await this.executionRepository.batchUpdateReview(executionIds, {
      reviewStatus: review.reviewStatus as ReviewStatus,
      reviewComment: review.reviewComment as string | undefined,
      failureReason: review.failureReason as string | undefined,
      testScenario: review.testScenario as string | undefined,
      reviewedBy: review.reviewedBy as string | undefined,
    });

    const batchIds = new Set(
      updatedExecutions.map((execution) => execution.batch_id).filter(Boolean),
    );

    for (const batchId of batchIds) {
      await this.updateBatchStats(batchId as string);
    }

    return updatedExecutions.length;
  }
}
