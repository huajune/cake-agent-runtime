import { Injectable } from '@nestjs/common';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import { TestBatchService } from '../execution/test-batch.service';
import { TestExecutionService } from '../execution/test-execution.service';
import { FeishuTestSyncService } from './feishu-test-sync.service';
import { TestWriteBackService } from './test-write-back.service';
import { ConversationTestService } from '../conversation/conversation-test.service';
import { TestSuiteProcessor } from '../../test-suite.processor';
import { ConversationSnapshotRepository } from '../../repositories/conversation-snapshot.repository';
import { BatchSource, BatchStatus, ExecutionStatus, TestType } from '../../enums/test.enum';

@Injectable()
export class TestImportService {
  constructor(
    private readonly batchService: TestBatchService,
    private readonly executionService: TestExecutionService,
    private readonly feishuSyncService: FeishuTestSyncService,
    private readonly writeBackService: TestWriteBackService,
    private readonly bitableApi: FeishuBitableApiService,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
    private readonly conversationTestService: ConversationTestService,
    private readonly testProcessor: TestSuiteProcessor,
  ) {}

  async importFromFeishu(request: Record<string, unknown>) {
    const cases = await this.feishuSyncService.getTestCases(
      request.appToken as string,
      request.tableId as string,
    );

    if (cases.length === 0) {
      throw new Error('飞书表格中没有数据');
    }

    const batch = await this.batchService.createBatch({
      name:
        (request.batchName as string | undefined) ||
        `飞书导入 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      source: BatchSource.FEISHU,
      feishuTableId: request.tableId,
      testType: request.testType,
    });

    const savedCases = [];
    for (const testCase of cases) {
      await this.executionService.saveExecution({
        batchId: batch.id,
        caseId: testCase.caseId,
        caseName: testCase.caseName,
        category: testCase.category,
        testInput: {
          message: testCase.message,
          history: testCase.history,
          scenario: 'candidate-consultation',
        },
        expectedOutput: testCase.expectedOutput,
        agentRequest: null,
        agentResponse: null,
        actualOutput: '',
        toolCalls: [],
        executionStatus: ExecutionStatus.PENDING,
        durationMs: 0,
        tokenUsage: null,
        errorMessage: null,
      });

      savedCases.push(testCase);
    }

    await this.batchService.updateBatchStats(batch.id);

    if (request.executeImmediately) {
      await this.batchService.updateBatchStatus(batch.id, BatchStatus.RUNNING);
      this.testProcessor.addBatchTestJobs(batch.id, cases).catch(() => undefined);
    }

    return {
      batchId: batch.id,
      batchName: batch.name,
      totalImported: savedCases.length,
      cases: savedCases,
    };
  }

  async quickCreateBatch(options?: {
    batchName?: string;
    parallel?: boolean;
    testType?: TestType;
  }) {
    const testType = options?.testType || TestType.SCENARIO;

    if (testType === TestType.CONVERSATION) {
      return this.quickCreateConversationBatch(options);
    }

    const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');

    return this.importFromFeishu({
      appToken,
      tableId,
      batchName:
        options?.batchName ||
        `用例测试 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      executeImmediately: true,
      parallel: options?.parallel || false,
      testType: TestType.SCENARIO,
    });
  }

  private async quickCreateConversationBatch(options?: {
    batchName?: string;
    testType?: TestType;
  }) {
    const { conversations } = await this.feishuSyncService.getConversationTestsFromDefaultTable();

    if (conversations.length === 0) {
      throw new Error('验证集表中没有回归验证数据');
    }

    const batch = await this.batchService.createBatch({
      name:
        options?.batchName ||
        `回归验证 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      source: BatchSource.FEISHU,
      testType: TestType.CONVERSATION,
    });

    for (const conversation of conversations) {
      const snapshot = await this.conversationSnapshotRepository.create({
        batchId: batch.id,
        feishuRecordId: conversation.recordId,
        conversationId: conversation.conversationId,
        participantName: conversation.participantName,
        fullConversation: conversation.parseResult.messages,
        rawText: conversation.rawText,
        totalTurns: conversation.parseResult.totalTurns,
      });

      await this.batchService.updateBatchStatus(batch.id, BatchStatus.RUNNING);
      const result = await this.conversationTestService.executeConversation(snapshot.id);
      const source = await this.conversationSnapshotRepository.findById(snapshot.id);

      if (source?.feishu_record_id) {
        await this.writeBackService.writeBackSimilarityScore(
          source.feishu_record_id,
          result.avgSimilarityScore,
        );
      }
    }

    await this.batchService.updateBatchStats(batch.id);

    return {
      batchId: batch.id,
      batchName: batch.name,
      totalImported: conversations.length,
      cases: [],
    };
  }
}
