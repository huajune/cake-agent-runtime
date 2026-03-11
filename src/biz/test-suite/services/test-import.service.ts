import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { FeishuBitableApiService } from '@core/feishu/services/feishu-bitable-api.service';
import { ImportFromFeishuRequestDto, ImportResult } from '../dto/test-chat.dto';
import { TestBatchService } from './test-batch.service';
import { TestExecutionService } from './test-execution.service';
import { FeishuTestSyncService } from './feishu-test-sync.service';
import { ConversationTestService } from './conversation-test.service';
import { TestSuiteProcessor } from '../test-suite.processor';
import { ConversationSourceRepository } from '@db/test-suite';
import {
  BatchStatus,
  BatchSource,
  ExecutionStatus,
  TestType,
  ConversationSourceStatus,
} from '../enums';

/**
 * 测试导入服务
 *
 * 职责：
 * - 从飞书多维表格导入测试用例
 * - 提供一键创建批次功能
 * - 协调导入和执行流程
 */
@Injectable()
export class TestImportService {
  private readonly logger = new Logger(TestImportService.name);

  constructor(
    private readonly batchService: TestBatchService,
    private readonly executionService: TestExecutionService,
    private readonly feishuSyncService: FeishuTestSyncService,
    private readonly feishuBitableApi: FeishuBitableApiService,
    private readonly conversationSourceRepository: ConversationSourceRepository,
    private readonly conversationTestService: ConversationTestService,
    @Inject(forwardRef(() => TestSuiteProcessor))
    private readonly testProcessor: TestSuiteProcessor,
  ) {
    this.logger.log('TestImportService 初始化完成');
  }

  /**
   * 从飞书多维表格导入测试用例
   */
  async importFromFeishu(request: ImportFromFeishuRequestDto): Promise<ImportResult> {
    this.logger.log(`从飞书导入测试用例: appToken=${request.appToken}, tableId=${request.tableId}`);

    // 1. 获取测试用例
    const cases = await this.feishuSyncService.getTestCases(request.appToken, request.tableId);
    this.logger.log(`从飞书获取 ${cases.length} 个有效测试用例`);

    if (cases.length === 0) {
      throw new Error('飞书表格中没有数据');
    }

    // 2. 创建批次
    const batchName =
      request.batchName ||
      `飞书导入 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    const batch = await this.batchService.createBatch({
      name: batchName,
      source: BatchSource.FEISHU,
      feishuAppToken: request.appToken,
      feishuTableId: request.tableId,
      testType: request.testType,
    });

    // 3. 保存测试用例（不执行）
    const savedCases: ImportResult['cases'] = [];
    for (const testCase of cases) {
      const execution = await this.executionService.saveExecution({
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

      savedCases.push({
        caseId: execution.id,
        caseName: testCase.caseName || '未命名',
        category: testCase.category,
        message: testCase.message,
      });
    }

    // 4. 更新批次统计
    await this.batchService.updateBatchStats(batch.id);

    // 5. 如果需要立即执行，使用任务队列
    if (request.executeImmediately) {
      this.logger.log('将测试用例添加到任务队列...');

      await this.batchService.updateBatchStatus(batch.id, BatchStatus.RUNNING);

      // 异步执行，不阻塞返回
      this.testProcessor.addBatchTestJobs(batch.id, cases).catch((err: Error) => {
        this.logger.error(`添加任务到队列失败: ${err.message}`, err.stack);
      });
    }

    return {
      batchId: batch.id,
      batchName: batch.name,
      totalImported: savedCases.length,
      cases: savedCases,
    };
  }

  /**
   * 一键从预配置的测试/验证集表导入并执行
   *
   * @param options.testType 测试类型：scenario-用例测试，conversation-回归验证
   */
  async quickCreateBatch(options?: {
    batchName?: string;
    parallel?: boolean;
    testType?: TestType;
  }): Promise<ImportResult> {
    const testType = options?.testType || TestType.SCENARIO;

    // 根据测试类型选择不同的数据源
    if (testType === TestType.CONVERSATION) {
      return this.quickCreateConversationBatch(options);
    }

    // 用例测试：从测试/验证集表导入
    const { appToken, tableId } = this.feishuBitableApi.getTableConfig('testSuite');

    this.logger.log(`一键创建用例测试: 从测试/验证集表 ${tableId} 导入`);

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

  /**
   * 一键创建回归验证批次
   * 从验证集表 (validationSet) 中获取回归验证数据
   *
   * 执行流程：
   * 1. 获取数据 → 2. 创建批次 → 3. 创建 ConversationSource → 4. 异步触发执行
   */
  private async quickCreateConversationBatch(options?: {
    batchName?: string;
    parallel?: boolean;
  }): Promise<ImportResult> {
    // 1. 从验证集表获取回归验证记录
    const { appToken, tableId, conversations } =
      await this.feishuSyncService.getConversationTestsFromDefaultTable();

    this.logger.log(`一键创建回归验证: 从验证集表 ${tableId} 导入回归验证数据`);
    this.logger.log(`获取到 ${conversations.length} 条回归验证记录`);

    if (conversations.length === 0) {
      throw new Error('验证集表中没有回归验证数据');
    }

    // 2. 创建批次
    const batchName =
      options?.batchName ||
      `回归验证 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    const batch = await this.batchService.createBatch({
      name: batchName,
      source: BatchSource.FEISHU,
      feishuAppToken: appToken,
      feishuTableId: tableId,
      testType: TestType.CONVERSATION,
    });

    // 3. 创建 ConversationSource 记录（复用现有数据结构）
    const savedCases: ImportResult['cases'] = [];
    const sourceIds: string[] = [];

    for (const conv of conversations) {
      const caseName = conv.participantName || '未知用户';

      // 使用 ConversationSource 存储（而非 TestExecution）
      const source = await this.conversationSourceRepository.create({
        batchId: batch.id,
        feishuRecordId: conv.recordId,
        conversationId: conv.conversationId || conv.recordId,
        participantName: conv.participantName || undefined,
        fullConversation: conv.parseResult.messages,
        rawText: conv.rawText,
        totalTurns: conv.parseResult.totalTurns,
      });

      sourceIds.push(source.id);

      savedCases.push({
        caseId: source.id,
        caseName,
        category: '回归验证',
        message: conv.rawText.slice(0, 100) + (conv.rawText.length > 100 ? '...' : ''),
      });
    }

    // 4. 更新批次状态为运行中
    await this.batchService.updateBatchStatus(batch.id, BatchStatus.RUNNING);

    // 5. 异步触发执行（不阻塞返回）
    this.executeConversationBatchAsync(batch.id, sourceIds).catch((err: Error) => {
      this.logger.error(`回归验证批量执行失败: ${err.message}`, err.stack);
    });

    this.logger.log(`回归验证批次已创建，共 ${savedCases.length} 条用例，开始异步执行`);

    return {
      batchId: batch.id,
      batchName: batch.name,
      totalImported: savedCases.length,
      cases: savedCases,
    };
  }

  /**
   * 异步执行回归验证批次
   * 复用 ConversationTestService.executeConversation()
   */
  private async executeConversationBatchAsync(batchId: string, sourceIds: string[]): Promise<void> {
    this.logger.log(`开始异步执行回归验证批次: ${batchId}, 共 ${sourceIds.length} 条对话`);

    let successCount = 0;
    let failedCount = 0;

    for (const sourceId of sourceIds) {
      try {
        // 复用现有的 executeConversation 方法
        const result = await this.conversationTestService.executeConversation(sourceId);
        successCount++;
        this.logger.debug(`对话 ${sourceId} 执行成功 (${successCount}/${sourceIds.length})`);

        // P0 修复：回写相似度分数到飞书
        await this.writeBackConversationResult(sourceId, result.avgSimilarityScore);
      } catch (error: unknown) {
        failedCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`对话 ${sourceId} 执行失败: ${errorMsg}`);

        // 更新对话源状态为失败
        await this.conversationSourceRepository.updateStatus(
          sourceId,
          ConversationSourceStatus.FAILED,
        );
      }
    }

    // 更新批次统计
    await this.batchService.updateBatchStats(batchId);

    // 更新批次状态
    const finalStatus =
      failedCount === sourceIds.length ? BatchStatus.CANCELLED : BatchStatus.REVIEWING;
    await this.batchService.updateBatchStatus(batchId, finalStatus);

    this.logger.log(`回归验证批次 ${batchId} 执行完成: 成功 ${successCount}, 失败 ${failedCount}`);
  }

  /**
   * 回写回归验证结果到飞书
   * 根据 sourceId 查询 feishuRecordId，然后回写相似度分数
   */
  private async writeBackConversationResult(
    sourceId: string,
    avgSimilarityScore: number | null,
  ): Promise<void> {
    try {
      // 获取对话源记录以获取飞书记录ID
      const source = await this.conversationSourceRepository.findById(sourceId);
      if (!source?.feishu_record_id) {
        this.logger.warn(`对话源 ${sourceId} 缺少飞书记录ID，跳过回写`);
        return;
      }

      // 回写相似度分数到飞书
      const result = await this.feishuSyncService.writeBackSimilarityScore(
        source.feishu_record_id,
        avgSimilarityScore,
      );

      if (result.success) {
        this.logger.debug(`对话 ${sourceId} 回写飞书成功，相似度=${avgSimilarityScore}`);
      } else {
        this.logger.warn(`对话 ${sourceId} 回写飞书失败: ${result.error}`);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`对话 ${sourceId} 回写飞书异常: ${errorMsg}`);
      // 不抛出异常，避免影响主流程
    }
  }
}
