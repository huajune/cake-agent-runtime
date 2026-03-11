import { Injectable, Logger } from '@nestjs/common';
import {
  TestChatRequestDto,
  TestChatResponse,
  BatchStats,
  CreateBatchRequestDto,
  UpdateReviewRequestDto,
  ImportFromFeishuRequestDto,
  ImportResult,
} from './dto/test-chat.dto';
import { TestBatch, TestExecution } from '@db/test-suite';
import {
  TestExecutionService,
  TestBatchService,
  TestImportService,
  TestWriteBackService,
} from './services';
import { BatchStatus, ExecutionStatus, ReviewStatus, FeishuTestStatus, TestType } from './enums';

/**
 * 测试套件门面服务
 *
 * 职责：
 * - 作为 Controller 和子服务之间的协调层
 * - 提供统一的 API 入口
 * - 委托具体实现给专门的子服务
 *
 * 子服务架构：
 * - TestExecutionService: 测试执行（单条/流式）
 * - TestBatchService: 批次管理（创建/查询/更新状态/评审）
 * - TestImportService: 飞书导入
 * - TestWriteBackService: 飞书回写
 *
 * 设计原则：
 * - 门面模式：简化复杂的子系统调用
 * - 单一职责：每个子服务只负责一类功能
 * - 依赖倒置：依赖抽象接口而非具体实现
 */
@Injectable()
export class TestSuiteService {
  private readonly logger = new Logger(TestSuiteService.name);

  constructor(
    private readonly executionService: TestExecutionService,
    private readonly batchService: TestBatchService,
    private readonly importService: TestImportService,
    private readonly writeBackService: TestWriteBackService,
  ) {
    this.logger.log('TestSuiteService 门面服务初始化完成');
  }

  // ========== 测试执行相关 (委托给 TestExecutionService) ==========

  /**
   * 执行单条测试
   */
  async executeTest(request: TestChatRequestDto): Promise<TestChatResponse> {
    return this.executionService.executeTest(request);
  }

  /**
   * 执行流式测试
   */
  async executeTestStream(request: TestChatRequestDto): Promise<NodeJS.ReadableStream> {
    return this.executionService.executeTestStream(request);
  }

  /**
   * 执行流式测试（带元数据）
   */
  async executeTestStreamWithMeta(
    request: TestChatRequestDto,
  ): Promise<{ stream: NodeJS.ReadableStream; estimatedInputTokens: number }> {
    return this.executionService.executeTestStreamWithMeta(request);
  }

  /**
   * 批量执行测试
   */
  async executeBatch(
    cases: TestChatRequestDto[],
    batchId?: string,
    parallel = false,
  ): Promise<TestChatResponse[]> {
    this.logger.log(`批量执行测试: ${cases.length} 个用例, 并行: ${parallel}`);

    if (batchId) {
      await this.batchService.updateBatchStatus(batchId, BatchStatus.RUNNING);
    }

    const results: TestChatResponse[] = [];

    if (parallel) {
      const batchSize = 5;
      for (let i = 0; i < cases.length; i += batchSize) {
        const batch = cases.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map((testCase) => this.executeTest({ ...testCase, batchId })),
        );
        results.push(...batchResults);
      }
    } else {
      for (const testCase of cases) {
        const result = await this.executeTest({ ...testCase, batchId });
        results.push(result);
      }
    }

    if (batchId) {
      await this.batchService.updateBatchStats(batchId);
      await this.batchService.updateBatchStatus(batchId, BatchStatus.REVIEWING);
    }

    return results;
  }

  /**
   * 获取执行记录详情
   */
  async getExecution(executionId: string): Promise<TestExecution | null> {
    return this.executionService.getExecution(executionId);
  }

  /**
   * 获取执行记录列表
   */
  async getExecutions(limit = 50, offset = 0): Promise<TestExecution[]> {
    return this.executionService.getExecutions(limit, offset);
  }

  // ========== 批次管理相关 (委托给 TestBatchService) ==========

  /**
   * 创建测试批次
   */
  async createBatch(request: CreateBatchRequestDto): Promise<TestBatch> {
    return this.batchService.createBatch(request);
  }

  /**
   * 获取测试批次列表
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
    return this.batchService.getBatches(limit, offset, testType);
  }

  /**
   * 获取批次详情
   */
  async getBatch(batchId: string): Promise<TestBatch | null> {
    return this.batchService.getBatch(batchId);
  }

  /**
   * 获取批次的执行记录（完整版）
   */
  async getBatchExecutions(
    batchId: string,
    filters?: {
      reviewStatus?: ReviewStatus;
      executionStatus?: ExecutionStatus;
      category?: string;
    },
  ): Promise<TestExecution[]> {
    return this.batchService.getBatchExecutions(batchId, filters);
  }

  /**
   * 获取批次的执行记录（列表版，轻量）
   */
  async getBatchExecutionsForList(
    batchId: string,
    filters?: {
      reviewStatus?: ReviewStatus;
      executionStatus?: ExecutionStatus;
      category?: string;
    },
  ) {
    return this.batchService.getBatchExecutionsForList(batchId, filters);
  }

  /**
   * 获取批次统计信息
   */
  async getBatchStats(batchId: string): Promise<BatchStats> {
    return this.batchService.getBatchStats(batchId);
  }

  /**
   * 获取分类统计
   */
  async getCategoryStats(
    batchId: string,
  ): Promise<Array<{ category: string; total: number; passed: number; failed: number }>> {
    return this.batchService.getCategoryStats(batchId);
  }

  /**
   * 获取失败原因统计
   */
  async getFailureReasonStats(
    batchId: string,
  ): Promise<Array<{ reason: string; count: number; percentage: number }>> {
    return this.batchService.getFailureReasonStats(batchId);
  }

  /**
   * 更新评审状态
   */
  async updateReview(executionId: string, review: UpdateReviewRequestDto): Promise<TestExecution> {
    return this.batchService.updateReview(executionId, review);
  }

  /**
   * 批量更新评审状态
   */
  async batchUpdateReview(executionIds: string[], review: UpdateReviewRequestDto): Promise<number> {
    return this.batchService.batchUpdateReview(executionIds, review);
  }

  // ========== 飞书导入相关 (委托给 TestImportService) ==========

  /**
   * 从飞书多维表格导入测试用例
   */
  async importFromFeishu(request: ImportFromFeishuRequestDto): Promise<ImportResult> {
    return this.importService.importFromFeishu(request);
  }

  /**
   * 一键从预配置的测试/验证集表导入并执行
   */
  async quickCreateBatch(options?: {
    batchName?: string;
    parallel?: boolean;
    testType?: TestType;
  }): Promise<ImportResult> {
    return this.importService.quickCreateBatch(options);
  }

  // ========== 飞书回写相关 (委托给 TestWriteBackService) ==========

  /**
   * 回写测试结果到飞书
   */
  async writeBackToFeishu(
    executionId: string,
    testStatus: FeishuTestStatus,
    errorReason?: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.writeBackService.writeBackToFeishu(executionId, testStatus, errorReason);
  }

  /**
   * 批量回写测试结果到飞书
   */
  async batchWriteBackToFeishu(
    items: Array<{
      executionId: string;
      testStatus: FeishuTestStatus;
      errorReason?: string;
    }>,
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    return this.writeBackService.batchWriteBackToFeishu(items);
  }

  // ========== 供 Processor 调用的方法 ==========

  /**
   * 更新批次状态
   */
  async updateBatchStatus(batchId: string, status: BatchStatus): Promise<void> {
    return this.batchService.updateBatchStatus(batchId, status);
  }

  /**
   * 更新批次统计信息
   */
  async updateBatchStats(batchId: string): Promise<void> {
    return this.batchService.updateBatchStats(batchId);
  }

  /**
   * 统计批次中已完成的执行记录数量
   */
  async countCompletedExecutions(batchId: string): Promise<{
    total: number;
    success: number;
    failure: number;
    timeout: number;
  }> {
    return this.executionService.countCompletedExecutions(batchId);
  }

  /**
   * 根据 batchId 和 caseId 更新执行记录
   */
  async updateExecutionByBatchAndCase(
    batchId: string,
    caseId: string,
    data: {
      agentRequest?: unknown;
      agentResponse?: unknown;
      actualOutput?: string;
      toolCalls?: unknown[];
      executionStatus: ExecutionStatus;
      durationMs: number;
      tokenUsage?: unknown;
      errorMessage?: string;
    },
  ): Promise<void> {
    return this.executionService.updateExecutionByBatchAndCase(batchId, caseId, data);
  }

  // ========== 向后兼容的公开方法（已废弃，供 Processor 调用） ==========

  /**
   * @deprecated 使用 updateBatchStatus 代替
   */
  async updateBatchStatusPublic(batchId: string, status: BatchStatus): Promise<void> {
    return this.updateBatchStatus(batchId, status);
  }

  /**
   * @deprecated 使用 updateBatchStats 代替
   */
  async updateBatchStatsPublic(batchId: string): Promise<void> {
    return this.updateBatchStats(batchId);
  }
}
