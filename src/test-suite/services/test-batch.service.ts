import { Injectable, Logger } from '@nestjs/common';
import { CreateBatchRequestDto, UpdateReviewRequestDto, BatchStats } from '../dto/test-chat.dto';
import {
  TestBatchRepository,
  TestExecutionRepository,
  TestBatch,
  TestExecution,
} from '../repositories';
import { TestStatsService } from './test-stats.service';
import { FeishuTestSyncService } from './feishu-test-sync.service';
import { BatchStatus, ExecutionStatus, ReviewStatus, FeishuTestStatus, TestType } from '../enums';

/**
 * 批次管理服务
 *
 * 职责：
 * - 创建、查询批次
 * - 更新批次状态和统计
 * - 管理批次内的执行记录
 * - 处理评审状态更新
 */
@Injectable()
export class TestBatchService {
  private readonly logger = new Logger(TestBatchService.name);

  constructor(
    private readonly batchRepository: TestBatchRepository,
    private readonly executionRepository: TestExecutionRepository,
    private readonly statsService: TestStatsService,
    private readonly feishuSyncService: FeishuTestSyncService,
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
      feishuAppToken: request.feishuAppToken,
      feishuTableId: request.feishuTableId,
      testType: request.testType,
    });
  }

  /**
   * 获取测试批次列表（带分页）
   *
   * @param limit 每页数量
   * @param offset 偏移量
   * @param testType 测试类型过滤：scenario-用例测试，conversation-回归验证
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
   * 只返回列表显示所需字段，提升性能
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
    return this.statsService.calculateBatchStats(batchId);
  }

  /**
   * 获取分类统计
   */
  async getCategoryStats(
    batchId: string,
  ): Promise<Array<{ category: string; total: number; passed: number; failed: number }>> {
    return this.statsService.calculateCategoryStats(batchId);
  }

  /**
   * 获取失败原因统计
   */
  async getFailureReasonStats(
    batchId: string,
  ): Promise<Array<{ reason: string; count: number; percentage: number }>> {
    return this.statsService.calculateFailureReasonStats(batchId);
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

    // 重新查询完整的执行记录
    const execution = await this.executionRepository.findById(executionId);
    if (!execution) {
      throw new Error(`执行记录不存在: ${executionId}`);
    }

    // 更新批次统计
    if (execution.batch_id) {
      await this.updateBatchStats(execution.batch_id);

      // 检查是否所有用例都已评审完成
      const stats = await this.getBatchStats(execution.batch_id);
      if (stats.pendingReviewCount === 0 && stats.totalCases > 0) {
        await this.updateBatchStatus(execution.batch_id, BatchStatus.COMPLETED);
        this.logger.log(`批次 ${execution.batch_id} 所有用例评审完成，状态更新为 completed`);
      }
    }

    // 回写飞书（如果有 case_id）
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

    // 获取涉及的批次并更新统计
    const batchIds = new Set(
      updatedExecutions.map((e: TestExecution) => e.batch_id).filter(Boolean),
    );
    for (const batchId of batchIds) {
      await this.updateBatchStats(batchId as string);
    }

    return updatedExecutions.length;
  }

  // ========== 私有方法 ==========

  /**
   * 异步回写飞书结果
   */
  private writeBackToFeishuAsync(execution: TestExecution, review: UpdateReviewRequestDto): void {
    const feishuStatus =
      review.reviewStatus === ReviewStatus.PASSED
        ? FeishuTestStatus.PASSED
        : review.reviewStatus === ReviewStatus.FAILED
          ? FeishuTestStatus.FAILED
          : FeishuTestStatus.SKIPPED;

    this.feishuSyncService
      .writeBackResult(
        execution.case_id!,
        feishuStatus,
        execution.batch_id || undefined,
        review.failureReason, // 错误原因（Agent 错误归因）
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
