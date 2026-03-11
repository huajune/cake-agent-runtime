import { Injectable, Logger } from '@nestjs/common';
import {
  FeishuBitableApiService,
  BitableField,
  BitableRecord,
} from '@core/feishu/services/feishu-bitable-api.service';
import { MessageRole, TestType } from '../../enums/test.enum';
import { ConversationParserService } from '../conversation/conversation-parser.service';
import { ConversationParseResult } from '../../dto/conversation-test.dto';

/**
 * 解析后的测试用例（用例测试）
 */
export interface ParsedTestCase {
  caseId: string; // 飞书记录 ID
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
  recordId: string; // 飞书记录 ID
  conversationId: string; // 对话标识
  participantName: string | null;
  rawText: string; // 原始对话文本（带时间戳）
  parseResult: ConversationParseResult;
  testType: TestType;
}

/**
 * 飞书测试/验证集同步服务（读取层）
 *
 * 职责：
 * - 从飞书多维表格读取测试用例
 * - 解析飞书记录为测试用例格式
 * - 解析飞书记录为回归验证格式
 *
 * 写回操作已迁移至 TestWriteBackService
 */
@Injectable()
export class FeishuTestSyncService {
  private readonly logger = new Logger(FeishuTestSyncService.name);

  constructor(
    private readonly bitableApi: FeishuBitableApiService,
    private readonly parserService: ConversationParserService,
  ) {
    this.logger.log('FeishuTestSyncService 初始化完成');
  }

  // ==================== 测试用例读取 ====================

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

  // ==================== 记录解析 ====================

  /**
   * 解析飞书记录为测试用例（支持用例测试和回归验证）
   */
  parseRecords(records: BitableRecord[], fields: BitableField[]): ParsedTestCase[] {
    const cases: ParsedTestCase[] = [];
    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);

    for (const record of records) {
      try {
        const recordFields = record.fields;

        // 提取测试类型（默认为用例测试）
        const testTypeStr = this.extractFieldValue(recordFields, fieldNameToId, [
          '测试类型',
          'test_type',
          '类型',
          'type',
        ]);
        const testType = testTypeStr === '对话验证' ? TestType.CONVERSATION : TestType.SCENARIO;

        // 回归验证类型，跳过解析（使用专门的方法）
        if (testType === TestType.CONVERSATION) {
          this.logger.debug(`跳过回归验证记录 ${record.record_id}，使用专门方法解析`);
          continue;
        }

        // 提取字段值（支持多种常见字段名）
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

        // 消息是必填的
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

        // 提取测试类型
        const testTypeStr = this.extractFieldValue(recordFields, fieldNameToId, [
          '测试类型',
          'test_type',
          '类型',
          'type',
        ]);

        // 只处理回归验证类型
        if (testTypeStr !== '对话验证') {
          continue;
        }

        // 提取对话记录字段
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

        // 提取参与者名称
        const participantName = this.extractFieldValue(recordFields, fieldNameToId, [
          '候选人微信昵称',
          '候选人姓名',
          '参与者',
          'participant',
          'name',
          '姓名',
        ]);

        // 使用 ConversationParserService 解析对话
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
   * 从预配置表获取回归验证记录
   *
   * 注意：回归验证数据现在从 validationSet 表读取（已从 testSuite 迁移）
   */
  async getConversationTestsFromDefaultTable(): Promise<{
    appToken: string;
    tableId: string;
    conversations: ParsedConversationTest[];
  }> {
    // 回归验证使用独立的验证集表
    const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');

    const fields = await this.bitableApi.getFields(appToken, tableId);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);

    // 验证集表的所有记录都是回归验证，不需要过滤 test_type
    const conversations = this.parseValidationSetRecords(records, fields);

    return { appToken, tableId, conversations };
  }

  /**
   * 解析验证集表记录（专用于 validationSet 表）
   *
   * 与 parseConversationRecords 的区别：
   * - 不需要检查 test_type 字段，所有记录都是回归验证
   * - 字段名可能略有不同
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

        // 提取对话记录字段
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

        // 提取参与者名称
        const participantName = this.extractFieldValue(recordFields, fieldNameToId, [
          '候选人微信昵称',
          '候选人姓名',
          '参与者',
          'participant',
          'name',
          '姓名',
        ]);

        // 使用 ConversationParserService 解析对话
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
      // 格式1: [时间 用户名] 消息内容
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

      // 格式2: user:/候选人: 开头
      if (line.startsWith('user:') || line.startsWith('候选人:')) {
        return { role: MessageRole.USER, content: line.replace(/^(user|候选人):\s*/i, '') };
      }

      // 格式3: AI:/assistant:/招募经理: 开头
      if (line.startsWith('AI:') || line.startsWith('assistant:') || line.startsWith('招募经理:')) {
        return {
          role: MessageRole.ASSISTANT,
          content: line.replace(/^(AI|assistant|招募经理):\s*/i, ''),
        };
      }

      // 默认当作用户消息
      return { role: MessageRole.USER, content: line };
    });
  }

  // ==================== 私有工具方法 ====================

  /**
   * 从记录中提取字段值（支持多个字段名候选）
   */
  private extractFieldValue(
    recordFields: Record<string, unknown>,
    fieldNameToId: Record<string, string>,
    candidateNames: string[],
  ): string | undefined {
    for (const name of candidateNames) {
      // 先尝试用字段 ID
      const fieldId = fieldNameToId[name];
      if (fieldId && recordFields[fieldId]) {
        return this.normalizeFieldValue(recordFields[fieldId]);
      }
      // 再尝试用字段名直接访问
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

    // 文本字段
    if (typeof value === 'string') {
      return value.trim();
    }

    // 数组（多行文本或多值字段）
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

    // 对象（富文本等）
    if (typeof value === 'object' && value !== null) {
      if ('text' in value) return String((value as { text: string }).text).trim();
      if ('value' in value) return String((value as { value: unknown }).value);
    }

    return String(value).trim();
  }
}
