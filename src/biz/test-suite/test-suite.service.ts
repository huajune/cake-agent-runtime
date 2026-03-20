import { Injectable, Logger } from '@nestjs/common';
import { streamText } from 'ai';
import {
  TestChatRequestDto,
  TestChatResponse,
  BatchStats,
  CreateBatchRequestDto,
  UpdateReviewRequestDto,
  ImportFromFeishuRequestDto,
  ImportResult,
  SubmitFeedbackRequestDto,
  VercelAIChatRequestDto,
} from './dto/test-chat.dto';
import { TestBatch } from './entities/test-batch.entity';
import { TestExecution } from './entities/test-execution.entity';
import { TestExecutionService } from './services/execution/test-execution.service';
import { TestBatchService } from './services/execution/test-batch.service';
import { TestImportService } from './services/feishu/test-import.service';
import { TestWriteBackService } from './services/feishu/test-write-back.service';
import { ConversationTestService } from './services/conversation/conversation-test.service';
import {
  BatchStatus,
  ExecutionStatus,
  ReviewStatus,
  FeishuTestStatus,
  TestType,
  ConversationSourceStatus,
} from './enums/test.enum';
import { MessageRole } from '@enums/message.enum';
import { FeishuBitableSyncService, AgentTestFeedback } from '@biz/feishu-sync/bitable-sync.service';
import { TestSuiteProcessor } from './test-suite.processor';
import { Inject, forwardRef } from '@nestjs/common';

/**
 * 测试套件门面服务
 *
 * 职责：
 * - 作为 Controller 和子服务之间的协调层
 * - 提供统一的 API 入口
 * - 委托具体实现给专门的子服务
 */
@Injectable()
export class TestSuiteService {
  private readonly logger = new Logger(TestSuiteService.name);

  constructor(
    private readonly executionService: TestExecutionService,
    private readonly batchService: TestBatchService,
    private readonly importService: TestImportService,
    private readonly writeBackService: TestWriteBackService,
    private readonly conversationTestService: ConversationTestService,
    private readonly feishuBitableService: FeishuBitableSyncService,
    @Inject(forwardRef(() => TestSuiteProcessor))
    private readonly testProcessor: TestSuiteProcessor,
  ) {
    this.logger.log('TestSuiteService 门面服务初始化完成');
  }

  // ========== 测试执行 ==========

  async executeTest(request: TestChatRequestDto): Promise<TestChatResponse> {
    return this.executionService.executeTest(request);
  }

  async executeTestStream(request: TestChatRequestDto): Promise<NodeJS.ReadableStream> {
    return this.executionService.executeTestStream(request);
  }

  async executeTestStreamWithMeta(
    request: TestChatRequestDto,
  ): Promise<ReturnType<typeof streamText>> {
    return this.executionService.executeTestStreamWithMeta(request);
  }

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

  async getExecution(executionId: string): Promise<TestExecution | null> {
    return this.executionService.getExecution(executionId);
  }

  async getExecutions(limit = 50, offset = 0): Promise<TestExecution[]> {
    return this.executionService.getExecutions(limit, offset);
  }

  // ========== 批次管理 ==========

  async createBatch(request: CreateBatchRequestDto): Promise<TestBatch> {
    return this.batchService.createBatch(request);
  }

  async getBatches(
    limit = 20,
    offset = 0,
    testType?: TestType,
  ): Promise<{ data: TestBatch[]; total: number }> {
    return this.batchService.getBatches(limit, offset, testType);
  }

  async getBatch(batchId: string): Promise<TestBatch | null> {
    return this.batchService.getBatch(batchId);
  }

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

  async getBatchStats(batchId: string): Promise<BatchStats> {
    return this.batchService.getBatchStats(batchId);
  }

  async getCategoryStats(
    batchId: string,
  ): Promise<Array<{ category: string; total: number; passed: number; failed: number }>> {
    return this.batchService.getCategoryStats(batchId);
  }

  async getFailureReasonStats(
    batchId: string,
  ): Promise<Array<{ reason: string; count: number; percentage: number }>> {
    return this.batchService.getFailureReasonStats(batchId);
  }

  async updateReview(executionId: string, review: UpdateReviewRequestDto): Promise<TestExecution> {
    return this.batchService.updateReview(executionId, review);
  }

  async batchUpdateReview(executionIds: string[], review: UpdateReviewRequestDto): Promise<number> {
    return this.batchService.batchUpdateReview(executionIds, review);
  }

  // ========== 批次进度与取消 ==========

  async getBatchProgress(batchId: string) {
    return this.testProcessor.getBatchProgress(batchId);
  }

  async cancelBatch(batchId: string) {
    const cancelled = await this.testProcessor.cancelBatchJobs(batchId);
    await this.batchService.updateBatchStatus(batchId, BatchStatus.CANCELLED);
    const totalCancelled = cancelled.waiting + cancelled.delayed + cancelled.active;

    return {
      batchId,
      cancelled,
      totalCancelled,
      message: `已取消 ${totalCancelled} 个任务（等待=${cancelled.waiting}, 延迟=${cancelled.delayed}, 执行中=${cancelled.active}）`,
    };
  }

  async getQueueStatus() {
    return this.testProcessor.getQueueStatus();
  }

  async cleanFailedJobs(): Promise<number> {
    return this.testProcessor.cleanFailedJobs();
  }

  // ========== 飞书导入 ==========

  async importFromFeishu(request: ImportFromFeishuRequestDto): Promise<ImportResult> {
    return this.importService.importFromFeishu(request);
  }

  async quickCreateBatch(options?: {
    batchName?: string;
    parallel?: boolean;
    testType?: TestType;
  }): Promise<ImportResult> {
    return this.importService.quickCreateBatch(options);
  }

  // ========== 飞书回写 ==========

  async writeBackToFeishu(
    executionId: string,
    testStatus: FeishuTestStatus,
    errorReason?: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.writeBackService.writeBackToFeishu(executionId, testStatus, errorReason);
  }

  async batchWriteBackToFeishu(
    items: Array<{
      executionId: string;
      testStatus: FeishuTestStatus;
      errorReason?: string;
    }>,
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    return this.writeBackService.batchWriteBackToFeishu(items);
  }

  // ========== 反馈 ==========

  async submitFeedback(
    request: SubmitFeedbackRequestDto,
  ): Promise<{ recordId?: string; type: string }> {
    const feedback: AgentTestFeedback = {
      type: request.type,
      chatHistory: request.chatHistory,
      userMessage: request.userMessage,
      errorType: request.errorType,
      remark: request.remark,
      chatId: request.chatId,
    };

    const result = await this.feishuBitableService.writeAgentTestFeedback(feedback);
    if (!result.success) {
      throw new Error(result.error || '写入飞书表格失败');
    }

    return { recordId: result.recordId, type: request.type };
  }

  // ========== Vercel AI SDK 格式转换 ==========

  convertVercelAIToTestRequest(request: VercelAIChatRequestDto): {
    testRequest: TestChatRequestDto;
    messageText: string;
  } {
    const userMessages = request.messages.filter((m) => m.role === 'user');
    const latestUserMessage = userMessages[userMessages.length - 1];

    const messageText =
      latestUserMessage?.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('') || '';

    const history = request.messages.slice(0, -1).map((msg) => {
      const textContent =
        msg.parts
          ?.filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('') || '';
      return {
        role: msg.role as MessageRole,
        content: textContent,
      };
    });

    const testRequest: TestChatRequestDto = {
      message: messageText,
      history,
      scenario: request.scenario || 'candidate-consultation',
      saveExecution: request.saveExecution ?? false,
      skipHistoryTrim: true,
      sessionId: request.sessionId,
      userId: request.userId,
      thinking: request.thinking,
    };

    return { testRequest, messageText };
  }

  // ========== 回归验证 ==========

  async getConversationSources(
    batchId: string,
    page?: number,
    pageSize?: number,
    status?: ConversationSourceStatus,
  ) {
    return this.conversationTestService.getConversationSources(batchId, page, pageSize, status);
  }

  async getConversationTurns(sourceId: string) {
    return this.conversationTestService.getConversationTurns(sourceId);
  }

  async executeConversation(sourceId: string, forceRerun?: boolean) {
    const result = await this.conversationTestService.executeConversation(sourceId, forceRerun);

    // 执行完成后，更新批次统计
    const batchId = await this.conversationTestService.getSourceBatchId(sourceId);
    if (batchId) {
      await this.batchService.updateBatchStats(batchId);
      this.logger.log(`[ConversationExecute] 已更新批次统计: batchId=${batchId}`);
    }

    return result;
  }

  async executeConversationBatch(batchId: string, forceRerun?: boolean) {
    const result = await this.conversationTestService.executeConversationBatch(batchId, forceRerun);

    // 批量执行完成后，更新批次统计
    await this.batchService.updateBatchStats(batchId);
    this.logger.log(`[ConversationBatchExecute] 已更新批次统计: batchId=${batchId}`);

    return result;
  }

  async updateTurnReview(executionId: string, reviewStatus: ReviewStatus, reviewComment?: string) {
    return this.conversationTestService.updateTurnReview(executionId, reviewStatus, reviewComment);
  }

  // ========== 供 Processor 调用 ==========

  async updateBatchStatus(batchId: string, status: BatchStatus): Promise<void> {
    return this.batchService.updateBatchStatus(batchId, status);
  }

  async updateBatchStats(batchId: string): Promise<void> {
    return this.batchService.updateBatchStats(batchId);
  }

  async countCompletedExecutions(batchId: string): Promise<{
    total: number;
    success: number;
    failure: number;
    timeout: number;
  }> {
    return this.executionService.countCompletedExecutions(batchId);
  }

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
}
