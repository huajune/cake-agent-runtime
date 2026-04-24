import { Injectable } from '@nestjs/common';
import { BitableField, FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import {
  ConversationDatasetSourceType,
  CuratedConversationCaseDto,
  CuratedScenarioCaseDto,
  ScenarioDatasetSourceType,
} from '../dto/test-chat.dto';
import {
  composeRemark,
  emptyToNull,
  ensureResolvedFields,
  firstId,
  joinIds,
  ResolvedFieldNames,
  resolveFieldNames,
  setField,
  truncate,
} from './curated-dataset-import.helpers';

const scenarioFieldAliases = {
  primaryText: ['用例主键', '用例标题', '多行文本', 'Text'],
  stableId: ['用例ID', 'caseId'],
  title: ['用例名称', '标题', '名称'],
  sourceBadCaseIds: ['来源BadCaseID'],
  sourceType: ['来源类型'],
  enabled: ['是否启用', '启用'],
  category: ['分类'],
  checkpoint: ['核心检查点'],
  expectedOutput: ['预期输出'],
  userMessage: ['用户消息'],
  chatHistory: ['聊天记录'],
  participantName: ['候选人微信昵称'],
  managerName: ['招募经理姓名'],
  consultTime: ['咨询时间'],
  remark: ['备注'],
  testStatus: ['测试状态'],
  lastTestTime: ['最近测试时间', '最近测试时间 (1)'],
  testBatch: ['测试批次'],
  errorReason: ['错误原因', '失败原因'],
  reviewSummary: ['评审摘要', '评审备注', '评审原因'],
  lastExecutionId: ['最近执行ID'],
} as const;

const conversationFieldAliases = {
  primaryText: ['验证主键', '验证标题展示', '多行文本', 'Text'],
  stableId: ['验证ID', 'validationId'],
  title: ['验证标题', '标题', '名称'],
  sourceBadCaseIds: ['来源BadCaseID'],
  sourceType: ['来源类型'],
  enabled: ['是否启用', '启用'],
  chatId: ['chatId', '会话ID', '会话 Id', '会话ID（chatId）'],
  participantName: ['候选人微信昵称'],
  managerName: ['招募经理姓名'],
  consultTime: ['咨询时间'],
  conversation: ['完整对话记录', '聊天记录', '对话记录'],
  remark: ['备注'],
  testStatus: ['测试状态'],
  lastTestTime: ['最近测试时间', '最近测试时间 (1)'],
  testBatch: ['测试批次'],
  similarityScore: ['相似度分数', '平均相似度'],
  minSimilarityScore: ['最低分'],
  evaluationSummary: ['评估摘要'],
  factualAccuracy: ['事实正确'],
  responseEfficiency: ['提问效率'],
  processCompliance: ['流程合规'],
  toneNaturalness: ['话术自然'],
} as const;

export type ScenarioFieldKey = keyof typeof scenarioFieldAliases;
export type ConversationFieldKey = keyof typeof conversationFieldAliases;

@Injectable()
export class CuratedDatasetPayloadBuilderService {
  constructor(private readonly bitableApi: FeishuBitableApiService) {}

  resolveScenarioFieldNames(fields: BitableField[]): ResolvedFieldNames<ScenarioFieldKey> {
    return resolveFieldNames(fields, scenarioFieldAliases);
  }

  ensureScenarioRequiredFields(resolved: ResolvedFieldNames<ScenarioFieldKey>): void {
    ensureResolvedFields('测试集', resolved, [
      'stableId',
      'title',
      'sourceType',
      'enabled',
      'userMessage',
    ]);
  }

  resolveConversationFieldNames(fields: BitableField[]): ResolvedFieldNames<ConversationFieldKey> {
    return resolveFieldNames(fields, conversationFieldAliases);
  }

  ensureConversationRequiredFields(resolved: ResolvedFieldNames<ConversationFieldKey>): void {
    ensureResolvedFields('验证集', resolved, [
      'stableId',
      'title',
      'sourceType',
      'enabled',
      'conversation',
    ]);
  }

  buildScenarioFields(
    resolved: ResolvedFieldNames<ScenarioFieldKey>,
    currentCase: CuratedScenarioCaseDto,
    importNote?: string,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    const remark = composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
      currentCase.sourceGoodCaseIds?.length
        ? `来源GoodCaseID: ${joinIds(currentCase.sourceGoodCaseIds)}`
        : undefined,
      currentCase.sourceChatIds?.length
        ? `来源ChatID: ${joinIds(currentCase.sourceChatIds)}`
        : undefined,
    ]);

    setField(fields, resolved.primaryText, currentCase.caseId.trim());
    setField(fields, resolved.stableId, currentCase.caseId.trim());
    setField(fields, resolved.title, this.truncate(currentCase.caseName.trim(), 500));
    setField(fields, resolved.sourceBadCaseIds, joinIds(currentCase.sourceBadCaseIds), {
      clearWithNull: true,
    });
    setField(
      fields,
      resolved.sourceType,
      currentCase.sourceType || ScenarioDatasetSourceType.MANUAL,
    );
    setField(fields, resolved.enabled, currentCase.enabled ?? true);
    setField(fields, resolved.category, emptyToNull(currentCase.category), { clearWithNull: true });
    setField(
      fields,
      resolved.checkpoint,
      this.truncate(emptyToNull(currentCase.checkpoint), 4000),
      {
        clearWithNull: true,
      },
    );
    setField(
      fields,
      resolved.expectedOutput,
      this.truncate(emptyToNull(currentCase.expectedOutput), 8000),
      { clearWithNull: true },
    );
    setField(fields, resolved.userMessage, this.truncate(currentCase.userMessage.trim(), 2000));
    setField(
      fields,
      resolved.chatHistory,
      this.truncate(emptyToNull(currentCase.chatHistory), 10000),
      {
        clearWithNull: true,
      },
    );
    setField(
      fields,
      resolved.participantName,
      this.truncate(emptyToNull(currentCase.participantName), 200),
      { clearWithNull: true },
    );
    setField(
      fields,
      resolved.managerName,
      this.truncate(emptyToNull(currentCase.managerName), 200),
      { clearWithNull: true },
    );
    setField(
      fields,
      resolved.consultTime,
      typeof currentCase.consultTime === 'number' ? currentCase.consultTime : null,
      { clearWithNull: true },
    );
    setField(fields, resolved.remark, this.truncate(remark, 8000), { clearWithNull: true });

    return fields;
  }

  buildConversationFields(
    resolved: ResolvedFieldNames<ConversationFieldKey>,
    currentCase: CuratedConversationCaseDto,
    importNote?: string,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    const primaryChatId = emptyToNull(currentCase.chatId) || firstId(currentCase.sourceChatIds);
    const remark = composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
      currentCase.sourceGoodCaseIds?.length
        ? `来源GoodCaseID: ${joinIds(currentCase.sourceGoodCaseIds)}`
        : undefined,
      currentCase.sourceChatIds?.length
        ? `来源ChatID: ${joinIds(currentCase.sourceChatIds)}`
        : undefined,
    ]);

    setField(fields, resolved.primaryText, currentCase.validationId.trim());
    setField(fields, resolved.stableId, currentCase.validationId.trim());
    setField(fields, resolved.title, this.truncate(currentCase.validationTitle.trim(), 500));
    setField(fields, resolved.sourceBadCaseIds, joinIds(currentCase.sourceBadCaseIds), {
      clearWithNull: true,
    });
    setField(
      fields,
      resolved.sourceType,
      currentCase.sourceType || ConversationDatasetSourceType.PRODUCTION,
    );
    setField(fields, resolved.enabled, currentCase.enabled ?? true);
    setField(fields, resolved.chatId, primaryChatId, { clearWithNull: true });
    setField(
      fields,
      resolved.participantName,
      this.truncate(emptyToNull(currentCase.participantName), 200),
      { clearWithNull: true },
    );
    setField(
      fields,
      resolved.managerName,
      this.truncate(emptyToNull(currentCase.managerName), 200),
      { clearWithNull: true },
    );
    setField(
      fields,
      resolved.consultTime,
      typeof currentCase.consultTime === 'number' ? currentCase.consultTime : null,
      { clearWithNull: true },
    );
    setField(fields, resolved.conversation, this.truncate(currentCase.conversation.trim(), 20000));
    setField(fields, resolved.remark, this.truncate(remark, 8000), { clearWithNull: true });

    return fields;
  }

  buildScenarioResetFields(
    resolved: ResolvedFieldNames<ScenarioFieldKey>,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    if (resolved.testStatus) {
      fields[resolved.testStatus] = '待测试';
    }
    if (resolved.lastTestTime) {
      fields[resolved.lastTestTime] = null;
    }
    if (resolved.testBatch) {
      fields[resolved.testBatch] = null;
    }
    if (resolved.errorReason) {
      fields[resolved.errorReason] = null;
    }
    if (resolved.reviewSummary) {
      fields[resolved.reviewSummary] = null;
    }
    if (resolved.lastExecutionId) {
      fields[resolved.lastExecutionId] = null;
    }

    return fields;
  }

  buildConversationResetFields(
    resolved: ResolvedFieldNames<ConversationFieldKey>,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    if (resolved.testStatus) {
      fields[resolved.testStatus] = '待测试';
    }
    if (resolved.lastTestTime) {
      fields[resolved.lastTestTime] = null;
    }
    if (resolved.testBatch) {
      fields[resolved.testBatch] = null;
    }
    if (resolved.similarityScore) {
      fields[resolved.similarityScore] = null;
    }
    if (resolved.minSimilarityScore) {
      fields[resolved.minSimilarityScore] = null;
    }
    if (resolved.evaluationSummary) {
      fields[resolved.evaluationSummary] = null;
    }
    if (resolved.factualAccuracy) {
      fields[resolved.factualAccuracy] = null;
    }
    if (resolved.responseEfficiency) {
      fields[resolved.responseEfficiency] = null;
    }
    if (resolved.processCompliance) {
      fields[resolved.processCompliance] = null;
    }
    if (resolved.toneNaturalness) {
      fields[resolved.toneNaturalness] = null;
    }

    return fields;
  }

  private truncate(value: string | null | undefined, maxLength: number): string | null {
    return truncate(this.bitableApi, value, maxLength);
  }
}
