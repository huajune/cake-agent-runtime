import { Injectable, Logger } from '@nestjs/common';
import {
  FeishuBitableApiService,
  BitableField,
  BitableRecord,
} from '@infra/feishu/services/bitable-api.service';
import { ImportFromFeishuRequestDto, ImportResult } from '../dto/test-chat.dto';
import { ConversationParserService } from '@evaluation/conversation-parser.service';
import { ConversationParseResult } from '../dto/conversation-test.dto';
import { TestBatchService } from './test-batch.service';
import { TestExecutionService } from './test-execution.service';
import { TestWriteBackService } from './test-write-back.service';
import { ConversationTestService } from './conversation-test.service';
import { TestSuiteProcessor } from '../test-suite.processor';
import { ConversationSnapshotRepository } from '../repositories/conversation-snapshot.repository';
import {
  BatchStatus,
  BatchSource,
  ExecutionStatus,
  TestType,
  ConversationSourceStatus,
  MessageRole,
} from '../enums/test.enum';

/**
 * 解析后的测试用例（用例测试）
 */
export interface ParsedTestCase {
  caseId: string;
  caseName: string;
  category?: string;
  message: string;
  history?: Array<{ role: MessageRole; content: string }>;
  expectedOutput?: string;
  testType: TestType;
}

/**
 * 解析后的回归验证记录
 */
export interface ParsedConversationTest {
  recordId: string;
  conversationId: string;
  participantName: string | null;
  rawText: string;
  parseResult: ConversationParseResult;
  testType: TestType;
}

/**
 * 测试导入服务
 *
 * 职责：
 * - 从飞书多维表格导入测试用例
 * - 提供一键创建批次功能
 * - 协调导入和执行流程
 * - 读取并解析飞书表格数据
 */
@Injectable()
export class TestImportService {
  private readonly logger = new Logger(TestImportService.name);

  constructor(
    private readonly batchService: TestBatchService,
    private readonly executionService: TestExecutionService,
    private readonly writeBackService: TestWriteBackService,
    private readonly bitableApi: FeishuBitableApiService,
    private readonly conversationSnapshotRepository: ConversationSnapshotRepository,
    private readonly conversationTestService: ConversationTestService,
    private readonly parserService: ConversationParserService,
    private readonly testProcessor: TestSuiteProcessor,
  ) {
    this.logger.log('TestImportService 初始化完成');
  }

  // ==================== 飞书数据导入 ====================

  /**
   * 从飞书多维表格导入测试用例
   */
  async importFromFeishu(request: ImportFromFeishuRequestDto): Promise<ImportResult> {
    this.logger.log(`从飞书导入测试用例: appToken=${request.appToken}, tableId=${request.tableId}`);

    const cases = await this.getTestCases(request.appToken, request.tableId);
    this.logger.log(`从飞书获取 ${cases.length} 个有效测试用例`);

    if (cases.length === 0) {
      throw new Error('飞书表格中没有数据');
    }

    const batchName =
      request.batchName ||
      `飞书导入 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    const batch = await this.batchService.createBatch({
      name: batchName,
      source: BatchSource.FEISHU,
      feishuTableId: request.tableId,
      testType: request.testType,
    });

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

    await this.batchService.updateBatchStats(batch.id);

    if (request.executeImmediately) {
      this.logger.log('将测试用例添加到任务队列...');

      await this.batchService.updateBatchStatus(batch.id, BatchStatus.RUNNING);

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
   */
  async quickCreateBatch(options?: {
    batchName?: string;
    parallel?: boolean;
    testType?: TestType;
  }): Promise<ImportResult> {
    const testType = options?.testType || TestType.SCENARIO;

    if (testType === TestType.CONVERSATION) {
      return this.quickCreateConversationBatch(options);
    }

    const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');

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

  // ==================== 飞书表格读取与解析 ====================

  /**
   * 从预配置的测试/验证集表获取所有测试用例
   */
  async getTestCasesFromDefaultTable(): Promise<{
    appToken: string;
    tableId: string;
    cases: ParsedTestCase[];
  }> {
    const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');

    const fields = await this.bitableApi.getFields(appToken, tableId);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);

    const cases = this.parseRecords(records, fields);

    return { appToken, tableId, cases };
  }

  /**
   * 从指定表格获取测试用例
   */
  async getTestCases(appToken: string, tableId: string): Promise<ParsedTestCase[]> {
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);

    return this.parseRecords(records, fields);
  }

  /**
   * 从预配置表获取回归验证记录
   */
  async getConversationTestsFromDefaultTable(): Promise<{
    appToken: string;
    tableId: string;
    conversations: ParsedConversationTest[];
  }> {
    const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');

    const fields = await this.bitableApi.getFields(appToken, tableId);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);

    const conversations = this.parseValidationSetRecords(records, fields);

    return { appToken, tableId, conversations };
  }

  /**
   * 解析飞书记录为测试用例
   */
  parseRecords(records: BitableRecord[], fields: BitableField[]): ParsedTestCase[] {
    const cases: ParsedTestCase[] = [];
    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);

    for (const record of records) {
      try {
        const recordFields = record.fields;

        const testTypeStr = this.extractFieldValue(recordFields, fieldNameToId, [
          '测试类型',
          'test_type',
          '类型',
          'type',
        ]);
        const testType = testTypeStr === '对话验证' ? TestType.CONVERSATION : TestType.SCENARIO;

        if (testType === TestType.CONVERSATION) {
          this.logger.debug(`跳过回归验证记录 ${record.record_id}，使用专门方法解析`);
          continue;
        }

        const caseName = this.extractFieldValue(recordFields, fieldNameToId, [
          '用例名称',
          '名称',
          'case_name',
          'name',
          '测试用例',
          '标题',
          '候选人微信昵称',
        ]);

        const message = this.extractFieldValue(recordFields, fieldNameToId, [
          '用户消息',
          '消息',
          'message',
          '输入',
          'input',
          '问题',
          'question',
        ]);

        if (!message) {
          this.logger.debug(`跳过记录 ${record.record_id}: 缺少消息字段`);
          continue;
        }

        const category = this.extractFieldValue(recordFields, fieldNameToId, [
          '分类',
          '类别',
          'category',
          '场景',
          '标签',
          'tag',
          '错误类型',
        ]);

        const historyText = this.extractFieldValue(recordFields, fieldNameToId, [
          '聊天记录',
          '历史记录',
          '对话历史',
          'history',
          '上下文',
          'context',
        ]);

        const expectedOutput = this.extractFieldValue(recordFields, fieldNameToId, [
          '预期输出',
          '预期答案',
          'expected',
          'expected_output',
          '答案',
          'answer',
        ]);

        cases.push({
          caseId: record.record_id,
          caseName: caseName || `测试用例 ${record.record_id}`,
          category: category || undefined,
          message,
          history: historyText ? this.parseHistory(historyText) : undefined,
          expectedOutput: expectedOutput || undefined,
          testType: TestType.SCENARIO,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`解析记录 ${record.record_id} 失败: ${errorMessage}`);
      }
    }

    this.logger.log(`成功解析 ${cases.length}/${records.length} 条用例测试用例`);
    return cases;
  }

  /**
   * 解析回归验证记录
   */
  parseConversationRecords(
    records: BitableRecord[],
    fields: BitableField[],
  ): ParsedConversationTest[] {
    const conversations: ParsedConversationTest[] = [];
    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);

    for (const record of records) {
      try {
        const recordFields = record.fields;

        const testTypeStr = this.extractFieldValue(recordFields, fieldNameToId, [
          '测试类型',
          'test_type',
          '类型',
          'type',
        ]);

        if (testTypeStr !== '对话验证') {
          continue;
        }

        const rawText = this.extractFieldValue(recordFields, fieldNameToId, [
          '完整对话记录',
          '对话记录',
          '聊天记录',
          'conversation',
          'full_conversation',
        ]);

        if (!rawText) {
          this.logger.debug(`跳过对话记录 ${record.record_id}: 缺少对话内容`);
          continue;
        }

        const participantName = this.extractFieldValue(recordFields, fieldNameToId, [
          '候选人微信昵称',
          '候选人姓名',
          '参与者',
          'participant',
          'name',
          '姓名',
        ]);

        const parseResult = this.parserService.parseConversation(rawText);

        if (!parseResult.success) {
          this.logger.warn(`对话解析失败 ${record.record_id}: ${parseResult.error || '未知错误'}`);
          continue;
        }

        conversations.push({
          recordId: record.record_id,
          conversationId: `conv-${record.record_id}`,
          participantName: participantName || null,
          rawText,
          parseResult,
          testType: TestType.CONVERSATION,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`解析对话记录 ${record.record_id} 失败: ${errorMessage}`);
      }
    }

    this.logger.log(`成功解析 ${conversations.length} 条回归验证记录`);
    return conversations;
  }

  /**
   * 解析验证集表记录（专用于 validationSet 表）
   */
  parseValidationSetRecords(
    records: BitableRecord[],
    fields: BitableField[],
  ): ParsedConversationTest[] {
    const conversations: ParsedConversationTest[] = [];
    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);

    for (const record of records) {
      try {
        const recordFields = record.fields;

        const rawText = this.extractFieldValue(recordFields, fieldNameToId, [
          '完整对话记录',
          '对话记录',
          '聊天记录',
          'conversation',
          'full_conversation',
        ]);

        if (!rawText) {
          this.logger.debug(`跳过验证集记录 ${record.record_id}: 缺少对话内容`);
          continue;
        }

        const participantName = this.extractFieldValue(recordFields, fieldNameToId, [
          '候选人微信昵称',
          '候选人姓名',
          '参与者',
          'participant',
          'name',
          '姓名',
        ]);

        const parseResult = this.parserService.parseConversation(rawText);

        if (!parseResult.success) {
          this.logger.warn(
            `验证集对话解析失败 ${record.record_id}: ${parseResult.error || '未知错误'}`,
          );
          continue;
        }

        conversations.push({
          recordId: record.record_id,
          conversationId: `conv-${record.record_id}`,
          participantName: participantName || null,
          rawText,
          parseResult,
          testType: TestType.CONVERSATION,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`解析验证集记录 ${record.record_id} 失败: ${errorMessage}`);
      }
    }

    this.logger.log(`成功解析 ${conversations.length} 条验证集对话记录`);
    return conversations;
  }

  /**
   * 解析对话历史文本
   */
  parseHistory(historyText: string): Array<{ role: MessageRole; content: string }> {
    if (!historyText?.trim()) return [];

    const lines = historyText.split('\n').filter((line) => line.trim());

    return lines.map((line) => {
      const bracketMatch = line.match(/^\[[\d/]+ [\d:]+ ([^\]]+)\]\s*(.*)$/);
      if (bracketMatch) {
        const userName = bracketMatch[1].trim();
        const content = bracketMatch[2];
        const isAssistant =
          userName === '招募经理' ||
          userName === '经理' ||
          userName === 'AI' ||
          userName === 'assistant';
        return { role: isAssistant ? MessageRole.ASSISTANT : MessageRole.USER, content };
      }

      if (line.startsWith('user:') || line.startsWith('候选人:')) {
        return { role: MessageRole.USER, content: line.replace(/^(user|候选人):\s*/i, '') };
      }

      if (line.startsWith('AI:') || line.startsWith('assistant:') || line.startsWith('招募经理:')) {
        return {
          role: MessageRole.ASSISTANT,
          content: line.replace(/^(AI|assistant|招募经理):\s*/i, ''),
        };
      }

      return { role: MessageRole.USER, content: line };
    });
  }

  // ==================== 私有方法 ====================

  /**
   * 一键创建回归验证批次
   */
  private async quickCreateConversationBatch(options?: {
    batchName?: string;
    parallel?: boolean;
  }): Promise<ImportResult> {
    const { tableId, conversations } = await this.getConversationTestsFromDefaultTable();

    this.logger.log(`一键创建回归验证: 从验证集表 ${tableId} 导入回归验证数据`);
    this.logger.log(`获取到 ${conversations.length} 条回归验证记录`);

    if (conversations.length === 0) {
      throw new Error('验证集表中没有回归验证数据');
    }

    const batchName =
      options?.batchName ||
      `回归验证 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    const batch = await this.batchService.createBatch({
      name: batchName,
      source: BatchSource.FEISHU,
      feishuTableId: tableId,
      testType: TestType.CONVERSATION,
    });

    const savedCases: ImportResult['cases'] = [];
    const sourceIds: string[] = [];

    for (const conv of conversations) {
      const caseName = conv.participantName || '未知用户';

      const source = await this.conversationSnapshotRepository.create({
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

    await this.batchService.updateBatchStatus(batch.id, BatchStatus.RUNNING);

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
   */
  private async executeConversationBatchAsync(batchId: string, sourceIds: string[]): Promise<void> {
    this.logger.log(`开始异步执行回归验证批次: ${batchId}, 共 ${sourceIds.length} 条对话`);

    let successCount = 0;
    let failedCount = 0;

    for (const sourceId of sourceIds) {
      try {
        const result = await this.conversationTestService.executeConversation(sourceId);
        successCount++;
        this.logger.debug(`对话 ${sourceId} 执行成功 (${successCount}/${sourceIds.length})`);

        await this.writeBackConversationResult(sourceId, result.avgSimilarityScore);
      } catch (error: unknown) {
        failedCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.error(`对话 ${sourceId} 执行失败: ${errorMsg}`);

        await this.conversationSnapshotRepository.updateStatus(
          sourceId,
          ConversationSourceStatus.FAILED,
        );
      }
    }

    await this.batchService.updateBatchStats(batchId);

    const finalStatus =
      failedCount === sourceIds.length ? BatchStatus.CANCELLED : BatchStatus.REVIEWING;
    await this.batchService.updateBatchStatus(batchId, finalStatus);

    this.logger.log(`回归验证批次 ${batchId} 执行完成: 成功 ${successCount}, 失败 ${failedCount}`);
  }

  /**
   * 回写回归验证结果到飞书
   */
  private async writeBackConversationResult(
    sourceId: string,
    avgSimilarityScore: number | null,
  ): Promise<void> {
    try {
      const source = await this.conversationSnapshotRepository.findById(sourceId);
      if (!source?.feishu_record_id) {
        this.logger.warn(`对话源 ${sourceId} 缺少飞书记录ID，跳过回写`);
        return;
      }

      const result = await this.writeBackService.writeBackSimilarityScore(
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
    }
  }

  /**
   * 从记录中提取字段值（支持多个字段名候选）
   */
  private extractFieldValue(
    recordFields: Record<string, unknown>,
    fieldNameToId: Record<string, string>,
    candidateNames: string[],
  ): string | undefined {
    for (const name of candidateNames) {
      const fieldId = fieldNameToId[name];
      if (fieldId && recordFields[fieldId]) {
        return this.normalizeFieldValue(recordFields[fieldId]);
      }
      if (recordFields[name]) {
        return this.normalizeFieldValue(recordFields[name]);
      }
    }
    return undefined;
  }

  /**
   * 标准化字段值（处理飞书的复杂字段类型）
   */
  private normalizeFieldValue(value: unknown): string | undefined {
    if (!value) return undefined;

    if (typeof value === 'string') {
      return value.trim();
    }

    if (Array.isArray(value)) {
      return value
        .map((item: unknown) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'text' in item) {
            return (item as { text: string }).text;
          }
          return String(item);
        })
        .join('\n')
        .trim();
    }

    if (typeof value === 'object' && value !== null) {
      if ('text' in value) return String((value as { text: string }).text).trim();
      if ('value' in value) return String((value as { value: unknown }).value);
    }

    return String(value).trim();
  }
}
