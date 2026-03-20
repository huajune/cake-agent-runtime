import { Injectable } from '@nestjs/common';
import { TestExecutionService } from './services/execution/test-execution.service';
import { TestBatchService } from './services/execution/test-batch.service';
import { TestImportService } from './services/feishu/test-import.service';
import { TestWriteBackService } from './services/feishu/test-write-back.service';
import { ConversationTestService } from './services/conversation/conversation-test.service';
import { FeishuBitableSyncService } from '@biz/feishu-sync/bitable-sync.service';
import { TestSuiteProcessor } from './test-suite.processor';
import {
  BatchStatus,
  ExecutionStatus,
  FeishuTestStatus,
  ReviewStatus,
} from './enums/test.enum';
import { VercelAIChatRequestDto } from './dto/test-chat.dto';

@Injectable()
export class TestSuiteService {
  constructor(
    private readonly executionService: TestExecutionService,
    private readonly batchService: TestBatchService,
    private readonly importService: TestImportService,
    private readonly writeBackService: TestWriteBackService,
    private readonly conversationTestService: ConversationTestService,
    private readonly feishuBitableService: FeishuBitableSyncService,
    private readonly testProcessor: TestSuiteProcessor,
  ) {}

  executeTest(request: Record<string, unknown>) {
    return this.executionService.executeTest(request as never);
  }

  executeTestStream(request: Record<string, unknown>) {
    return this.executionService.executeTestStream(request as never);
  }

  executeTestStreamWithMeta(request: Record<string, unknown>): Promise<unknown> {
    return this.executionService.executeTestStreamWithMeta(request as never) as Promise<unknown>;
  }

  async executeBatch(
    cases: Array<Record<string, unknown>>,
    batchId?: string,
    parallel: boolean = false,
  ) {
    if (batchId) {
      await this.batchService.updateBatchStatus(batchId, BatchStatus.RUNNING);
    }

    const execute = (testCase: Record<string, unknown>) =>
      this.executionService.executeTest({ ...testCase, batchId } as never);

    let results = [];

    if (parallel) {
      for (let i = 0; i < cases.length; i += 5) {
        const chunk = cases.slice(i, i + 5);
        results = results.concat(await Promise.all(chunk.map(execute)));
      }
    } else {
      for (const testCase of cases) {
        results.push(await execute(testCase));
      }
    }

    if (batchId) {
      await this.batchService.updateBatchStats(batchId);
      await this.batchService.updateBatchStatus(batchId, BatchStatus.REVIEWING);
    }

    return results;
  }

  getExecution(executionId: string) {
    return this.executionService.getExecution(executionId);
  }

  getExecutions(limit = 50, offset = 0) {
    return this.executionService.getExecutions(limit, offset);
  }

  createBatch(request: Record<string, unknown>) {
    return this.batchService.createBatch(request);
  }

  getBatches(limit = 20, offset = 0, testType?: string) {
    return this.batchService.getBatches(limit, offset, testType);
  }

  getBatch(batchId: string) {
    return this.batchService.getBatch(batchId);
  }

  getBatchExecutionsForList(batchId: string, filters?: Record<string, unknown>) {
    return this.batchService.getBatchExecutionsForList(batchId, filters);
  }

  getBatchStats(batchId: string) {
    return this.batchService.getBatchStats(batchId);
  }

  getCategoryStats(batchId: string) {
    return this.batchService.getCategoryStats(batchId);
  }

  getFailureReasonStats(batchId: string) {
    return this.batchService.getFailureReasonStats(batchId);
  }

  updateReview(executionId: string, review: Record<string, unknown>) {
    return this.batchService.updateReview(executionId, review);
  }

  batchUpdateReview(executionIds: string[], review: Record<string, unknown>) {
    return this.batchService.batchUpdateReview(executionIds, review);
  }

  getBatchProgress(batchId: string) {
    return this.testProcessor.getBatchProgress(batchId);
  }

  async cancelBatch(batchId: string) {
    const cancelled = await this.testProcessor.cancelBatchJobs(batchId);
    await this.batchService.updateBatchStatus(batchId, BatchStatus.CANCELLED);

    return {
      batchId,
      cancelled,
      totalCancelled: cancelled.waiting + cancelled.delayed + cancelled.active,
    };
  }

  getQueueStatus() {
    return this.testProcessor.getQueueStatus();
  }

  cleanFailedJobs() {
    return this.testProcessor.cleanFailedJobs();
  }

  importFromFeishu(request: Record<string, unknown>) {
    return this.importService.importFromFeishu(request);
  }

  quickCreateBatch(options?: { batchName?: string; parallel?: boolean; testType?: string }) {
    return this.importService.quickCreateBatch(options as never);
  }

  writeBackToFeishu(
    executionId: string,
    testStatus: FeishuTestStatus,
    errorReason?: string,
  ) {
    return this.writeBackService.writeBackToFeishu(executionId, testStatus, errorReason);
  }

  batchWriteBackToFeishu(items: Array<Record<string, unknown>>) {
    return this.writeBackService.batchWriteBackToFeishu(items as never);
  }

  async submitFeedback(feedback: Record<string, unknown>) {
    const result = await this.feishuBitableService.writeAgentTestFeedback(feedback as never);
    if (!result.success) {
      throw new Error(result.error || '写入飞书表格失败');
    }

    return {
      ...result,
      type: feedback.type,
    };
  }

  convertVercelAIToTestRequest(request: VercelAIChatRequestDto) {
    if (typeof this.executionService.convertVercelAIToTestRequest === 'function') {
      return this.executionService.convertVercelAIToTestRequest(request);
    }

    const messages = request.messages || [];
    const userMessages = messages.filter((message) => message.role === 'user');
    const latestUserMessage = userMessages[userMessages.length - 1];

    const messageText =
      latestUserMessage?.parts
        ?.filter((part) => part.type === 'text')
        .map((part) => part.text || '')
        .join('') || '';

    const history = messages.slice(0, -1).map((message) => ({
      role: message.role,
      content:
        message.parts
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text || '')
          .join('') || '',
    }));

    return {
      testRequest: {
        message: messageText,
        history,
        scenario: request.scenario || 'candidate-consultation',
        saveExecution: request.saveExecution ?? false,
        skipHistoryTrim: true,
        sessionId: request.sessionId,
        userId: request.userId,
        thinking: request.thinking,
      },
      messageText,
    };
  }

  getConversationSources(batchId: string, page = 1, pageSize = 20, status?: string) {
    return this.conversationTestService.getConversationSources(batchId, page, pageSize, status as never);
  }

  getConversationTurns(sourceId: string) {
    return this.conversationTestService.getConversationTurns(sourceId);
  }

  async executeConversation(sourceId: string, forceRerun?: boolean) {
    const result = await this.conversationTestService.executeConversation(sourceId, forceRerun);
    const batchId = await this.conversationTestService.getSourceBatchId(sourceId);
    if (batchId) {
      await this.batchService.updateBatchStats(batchId);
    }
    return result;
  }

  async executeConversationBatch(batchId: string, forceRerun?: boolean) {
    const result = await this.conversationTestService.executeConversationBatch(batchId, forceRerun);
    await this.batchService.updateBatchStats(batchId);
    return result;
  }

  updateTurnReview(
    executionId: string,
    reviewStatus: ReviewStatus,
    reviewComment?: string,
  ) {
    return this.conversationTestService.updateTurnReview(executionId, reviewStatus, reviewComment);
  }

  updateBatchStatus(batchId: string, status: BatchStatus) {
    return this.batchService.updateBatchStatus(batchId, status);
  }

  updateBatchStats(batchId: string) {
    return this.batchService.updateBatchStats(batchId);
  }

  countCompletedExecutions(batchId: string) {
    return this.executionService.countCompletedExecutions(batchId);
  }

  updateExecutionByBatchAndCase(
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
  ) {
    return this.executionService.updateExecutionByBatchAndCase(batchId, caseId, data);
  }
}
