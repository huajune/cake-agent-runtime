import { Injectable } from '@nestjs/common';
import {
  FeishuBitableApiService,
  BitableField,
  BitableRecord,
} from '@infra/feishu/services/bitable-api.service';
import { ConversationParserService } from '../conversation/conversation-parser.service';
import { MessageRole, TestType } from '../../enums/test.enum';

@Injectable()
export class FeishuTestSyncService {
  constructor(
    private readonly bitableApi: FeishuBitableApiService,
    private readonly parserService: ConversationParserService,
  ) {}

  async getTestCasesFromDefaultTable() {
    const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);
    return {
      appToken,
      tableId,
      cases: this.parseRecords(records, fields),
    };
  }

  async getTestCases(appToken: string, tableId: string) {
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);
    return this.parseRecords(records, fields);
  }

  parseRecords(records: BitableRecord[], fields: BitableField[]) {
    const fieldMap = this.bitableApi.buildFieldNameToIdMap(fields);

    return records
      .map((record) => {
        const testType = this.getTextValue(record.fields[fieldMap['测试类型']]);
        if (testType === '对话验证') {
          return null;
        }

        const message = this.getTextValue(record.fields[fieldMap['用户消息']]);
        if (!message) {
          return null;
        }

        return {
          caseId: record.record_id,
          caseName:
            this.getTextValue(record.fields[fieldMap['用例名称']]) ||
            `测试用例 ${record.record_id}`,
          category: this.getTextValue(record.fields[fieldMap['分类']]) || undefined,
          message,
          history: this.parseHistory(this.getTextValue(record.fields[fieldMap['聊天记录']])),
          expectedOutput: this.getTextValue(record.fields[fieldMap['期望输出']]) || undefined,
          testType: TestType.SCENARIO,
        };
      })
      .filter(Boolean);
  }

  parseConversationRecords(records: BitableRecord[], fields: BitableField[]) {
    const fieldMap = this.bitableApi.buildFieldNameToIdMap(fields);

    return records
      .map((record) => {
        const testType = this.getTextValue(record.fields[fieldMap['测试类型']]);
        if (testType !== '对话验证') {
          return null;
        }

        const rawText = this.getTextValue(record.fields[fieldMap['完整对话记录']]);
        if (!rawText) {
          return null;
        }

        const parseResult = this.parserService.parseConversation(rawText);
        if (!parseResult.success) {
          return null;
        }

        return {
          recordId: record.record_id,
          conversationId: `conv-${record.record_id}`,
          participantName: null,
          rawText,
          parseResult,
          testType: TestType.CONVERSATION,
        };
      })
      .filter(Boolean);
  }

  parseValidationSetRecords(records: BitableRecord[], fields: BitableField[]) {
    const fieldMap = this.bitableApi.buildFieldNameToIdMap(fields);

    return records
      .map((record) => {
        const rawText = this.getTextValue(record.fields[fieldMap['完整对话记录']]);
        if (!rawText) {
          return null;
        }

        const parseResult = this.parserService.parseConversation(rawText);
        if (!parseResult.success) {
          return null;
        }

        return {
          recordId: record.record_id,
          conversationId: `conv-${record.record_id}`,
          participantName: null,
          rawText,
          parseResult,
          testType: TestType.CONVERSATION,
        };
      })
      .filter(Boolean);
  }

  parseHistory(historyText?: string) {
    if (!historyText || !historyText.trim()) {
      return [];
    }

    return historyText
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const bracketMatch = line.match(/^\[[^\]]+\s+(候选人|招募经理)\]\s*(.+)$/);
        if (bracketMatch) {
          return {
            role: bracketMatch[1] === '招募经理' ? MessageRole.ASSISTANT : MessageRole.USER,
            content: bracketMatch[2].trim(),
          };
        }

        const prefixMatch = line.match(/^(user|assistant|AI|候选人|招募经理)\s*:\s*(.+)$/i);
        if (prefixMatch) {
          const prefix = prefixMatch[1].toLowerCase();
          const role =
            prefix === 'assistant' || prefix === 'ai' || prefix === '招募经理'
              ? MessageRole.ASSISTANT
              : MessageRole.USER;
          return {
            role,
            content: prefixMatch[2].trim(),
          };
        }

        return {
          role: MessageRole.USER,
          content: line.trim(),
        };
      });
  }

  async getConversationTestsFromDefaultTable() {
    const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);
    return {
      appToken,
      tableId,
      conversations: this.parseValidationSetRecords(records, fields),
    };
  }

  private getTextValue(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'text' in item) {
            return String((item as { text: unknown }).text);
          }
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }

    return '';
  }
}
