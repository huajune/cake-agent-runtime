import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  BitableField,
  BitableRecord,
  FeishuBitableApiService,
} from '@infra/feishu/services/bitable-api.service';
import {
  ConversationDatasetSourceType,
  CuratedConversationCaseDto,
  CuratedDatasetImportResult,
  CuratedScenarioCaseDto,
  ImportCuratedConversationDatasetRequestDto,
  ImportCuratedScenarioDatasetRequestDto,
  ScenarioDatasetSourceType,
} from '../dto/test-chat.dto';

type ResolvedFieldNames<T extends string> = Partial<Record<T, string>>;

type LineageSourceTable = 'BadCase' | 'GoodCase' | 'Chat';
type LineageTargetTable = '测试集' | '验证集';
type LineageRelationRole = '问题来源' | '正样本参考' | '对话证据';
type LineageFieldKey =
  | 'primaryText'
  | 'relationId'
  | 'sourceTable'
  | 'sourceAssetId'
  | 'targetTable'
  | 'targetAssetId'
  | 'targetTitle'
  | 'targetRecordId'
  | 'relationRole'
  | 'curatedSourceType'
  | 'enabled'
  | 'remark'
  | 'syncedAt';

interface DesiredLineageRelation {
  relationId: string;
  summary: string;
  sourceTable: LineageSourceTable;
  sourceAssetId: string;
  targetTable: LineageTargetTable;
  targetAssetId: string;
  targetTitle: string;
  targetRecordId: string;
  relationRole: LineageRelationRole;
  curatedSourceType: string;
  enabled: boolean;
  remark?: string | null;
  syncedAt: number;
}

interface LineageTableContext {
  appToken: string;
  tableId: string;
  fieldNameToId: Record<string, string>;
  resolved: ResolvedFieldNames<LineageFieldKey>;
  recordsByRelationId: Map<string, BitableRecord>;
  recordsByTargetKey: Map<string, BitableRecord[]>;
}

@Injectable()
export class CuratedDatasetImportService {
  private readonly logger = new Logger(CuratedDatasetImportService.name);

  private readonly scenarioFieldAliases = {
    primaryText: ['多行文本', 'Text'],
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
    lastExecutionId: ['最近执行ID'],
  } as const;

  private readonly conversationFieldAliases = {
    primaryText: ['多行文本', 'Text'],
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

  private readonly lineageFieldAliases = {
    primaryText: ['多行文本', 'Text'],
    relationId: ['关系ID'],
    sourceTable: ['来源表'],
    sourceAssetId: ['来源资产ID'],
    targetTable: ['目标表'],
    targetAssetId: ['目标资产ID'],
    targetTitle: ['目标标题'],
    targetRecordId: ['目标FeishuRecordID'],
    relationRole: ['关系角色'],
    curatedSourceType: ['策展来源类型'],
    enabled: ['是否生效', '启用'],
    remark: ['备注'],
    syncedAt: ['最近同步时间'],
  } as const;

  constructor(private readonly bitableApi: FeishuBitableApiService) {}

  async importScenarioDataset(
    request: ImportCuratedScenarioDatasetRequestDto,
  ): Promise<CuratedDatasetImportResult> {
    if (!request.cases?.length) {
      throw new Error('测试集导入不能为空');
    }

    const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const resolved = this.resolveFieldNames(fields, this.scenarioFieldAliases);
    this.ensureResolvedFields('测试集', resolved, [
      'stableId',
      'title',
      'sourceType',
      'enabled',
      'userMessage',
    ]);

    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);
    const existingByStableId = this.buildRecordIndex(records, fieldNameToId, resolved.stableId);
    const lineageContext = await this.loadLineageTableContext();

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const recordIds: string[] = [];

    for (const currentCase of request.cases) {
      const desiredFields = this.buildScenarioFields(resolved, currentCase, request.importNote);
      const stableId = currentCase.caseId.trim();
      const existing = existingByStableId.get(stableId);
      let targetRecordId: string;

      if (!existing) {
        const createPayload = this.stripNilFields({
          ...desiredFields,
          ...this.buildScenarioResetFields(resolved),
        });
        const result = await this.bitableApi.createRecord(appToken, tableId, createPayload);
        targetRecordId = result.recordId;
        created++;
      } else {
        targetRecordId = existing.record_id;
        const changedFieldNames = this.getChangedFieldNames(existing, fieldNameToId, desiredFields);
        if (changedFieldNames.length === 0) {
          unchanged++;
        } else {
          const updatePayload = {
            ...desiredFields,
            ...this.buildScenarioResetFields(resolved),
          };
          const result = await this.bitableApi.updateRecord(
            appToken,
            tableId,
            existing.record_id,
            updatePayload,
          );

          if (!result.success) {
            throw new Error(
              `更新测试集记录失败(caseId=${stableId}): ${result.error || '未知错误'}`,
            );
          }

          this.logger.log(
            `测试集 upsert 更新: caseId=${stableId}, recordId=${existing.record_id}, fields=${changedFieldNames.join(', ')}`,
          );
          updated++;
        }
      }

      await this.syncTargetLineageRelations(
        lineageContext,
        this.buildScenarioLineageRelations(currentCase, targetRecordId, request.importNote),
        '测试集',
        stableId,
      );
      recordIds.push(targetRecordId);
    }

    return {
      created,
      updated,
      unchanged,
      total: request.cases.length,
      recordIds,
    };
  }

  async importConversationDataset(
    request: ImportCuratedConversationDatasetRequestDto,
  ): Promise<CuratedDatasetImportResult> {
    if (!request.cases?.length) {
      throw new Error('验证集导入不能为空');
    }

    const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const resolved = this.resolveFieldNames(fields, this.conversationFieldAliases);
    this.ensureResolvedFields('验证集', resolved, [
      'stableId',
      'title',
      'sourceType',
      'enabled',
      'conversation',
    ]);

    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);
    const existingByStableId = this.buildRecordIndex(records, fieldNameToId, resolved.stableId);
    const lineageContext = await this.loadLineageTableContext();

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const recordIds: string[] = [];

    for (const currentCase of request.cases) {
      const desiredFields = this.buildConversationFields(resolved, currentCase, request.importNote);
      const stableId = currentCase.validationId.trim();
      const existing = existingByStableId.get(stableId);
      let targetRecordId: string;

      if (!existing) {
        const createPayload = this.stripNilFields({
          ...desiredFields,
          ...this.buildConversationResetFields(resolved),
        });
        const result = await this.bitableApi.createRecord(appToken, tableId, createPayload);
        targetRecordId = result.recordId;
        created++;
      } else {
        targetRecordId = existing.record_id;
        const changedFieldNames = this.getChangedFieldNames(existing, fieldNameToId, desiredFields);
        if (changedFieldNames.length === 0) {
          unchanged++;
        } else {
          const updatePayload = {
            ...desiredFields,
            ...this.buildConversationResetFields(resolved),
          };
          const result = await this.bitableApi.updateRecord(
            appToken,
            tableId,
            existing.record_id,
            updatePayload,
          );

          if (!result.success) {
            throw new Error(
              `更新验证集记录失败(validationId=${stableId}): ${result.error || '未知错误'}`,
            );
          }

          this.logger.log(
            `验证集 upsert 更新: validationId=${stableId}, recordId=${existing.record_id}, fields=${changedFieldNames.join(', ')}`,
          );
          updated++;
        }
      }

      await this.syncTargetLineageRelations(
        lineageContext,
        this.buildConversationLineageRelations(currentCase, targetRecordId, request.importNote),
        '验证集',
        stableId,
      );
      recordIds.push(targetRecordId);
    }

    return {
      created,
      updated,
      unchanged,
      total: request.cases.length,
      recordIds,
    };
  }

  private buildScenarioFields(
    resolved: ResolvedFieldNames<keyof typeof this.scenarioFieldAliases>,
    currentCase: CuratedScenarioCaseDto,
    importNote?: string,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    const setField = (
      fieldName: string | undefined,
      value: unknown,
      options?: { clearWithNull?: boolean },
    ) => {
      if (!fieldName) return;

      if (value === undefined || value === null) {
        if (options?.clearWithNull) {
          fields[fieldName] = null;
        }
        return;
      }

      fields[fieldName] = value;
    };

    const remark = this.composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
      currentCase.sourceGoodCaseIds?.length
        ? `来源GoodCaseID: ${this.joinIds(currentCase.sourceGoodCaseIds)}`
        : undefined,
      currentCase.sourceChatIds?.length
        ? `来源ChatID: ${this.joinIds(currentCase.sourceChatIds)}`
        : undefined,
    ]);

    setField(resolved.primaryText, this.truncate(currentCase.caseName.trim(), 500));
    setField(resolved.stableId, currentCase.caseId.trim());
    setField(resolved.title, this.truncate(currentCase.caseName.trim(), 500));
    setField(resolved.sourceBadCaseIds, this.joinIds(currentCase.sourceBadCaseIds), {
      clearWithNull: true,
    });
    setField(resolved.sourceType, currentCase.sourceType || ScenarioDatasetSourceType.MANUAL);
    setField(resolved.enabled, currentCase.enabled ?? true);
    setField(resolved.category, this.emptyToNull(currentCase.category), { clearWithNull: true });
    setField(resolved.checkpoint, this.truncate(this.emptyToNull(currentCase.checkpoint), 4000), {
      clearWithNull: true,
    });
    setField(
      resolved.expectedOutput,
      this.truncate(this.emptyToNull(currentCase.expectedOutput), 8000),
      { clearWithNull: true },
    );
    setField(resolved.userMessage, this.truncate(currentCase.userMessage.trim(), 2000));
    setField(
      resolved.chatHistory,
      this.truncate(this.emptyToNull(currentCase.chatHistory), 10000),
      { clearWithNull: true },
    );
    setField(
      resolved.participantName,
      this.truncate(this.emptyToNull(currentCase.participantName), 200),
      { clearWithNull: true },
    );
    setField(resolved.managerName, this.truncate(this.emptyToNull(currentCase.managerName), 200), {
      clearWithNull: true,
    });
    setField(
      resolved.consultTime,
      typeof currentCase.consultTime === 'number' ? currentCase.consultTime : null,
      { clearWithNull: true },
    );
    setField(resolved.remark, this.truncate(remark, 8000), { clearWithNull: true });

    return fields;
  }

  private buildConversationFields(
    resolved: ResolvedFieldNames<keyof typeof this.conversationFieldAliases>,
    currentCase: CuratedConversationCaseDto,
    importNote?: string,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    const setField = (
      fieldName: string | undefined,
      value: unknown,
      options?: { clearWithNull?: boolean },
    ) => {
      if (!fieldName) return;

      if (value === undefined || value === null) {
        if (options?.clearWithNull) {
          fields[fieldName] = null;
        }
        return;
      }

      fields[fieldName] = value;
    };

    const primaryChatId =
      this.emptyToNull(currentCase.chatId) || this.firstId(currentCase.sourceChatIds);
    const remark = this.composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
      currentCase.sourceGoodCaseIds?.length
        ? `来源GoodCaseID: ${this.joinIds(currentCase.sourceGoodCaseIds)}`
        : undefined,
      currentCase.sourceChatIds?.length
        ? `来源ChatID: ${this.joinIds(currentCase.sourceChatIds)}`
        : undefined,
    ]);

    setField(resolved.primaryText, this.truncate(currentCase.validationTitle.trim(), 500));
    setField(resolved.stableId, currentCase.validationId.trim());
    setField(resolved.title, this.truncate(currentCase.validationTitle.trim(), 500));
    setField(resolved.sourceBadCaseIds, this.joinIds(currentCase.sourceBadCaseIds), {
      clearWithNull: true,
    });
    setField(
      resolved.sourceType,
      currentCase.sourceType || ConversationDatasetSourceType.PRODUCTION,
    );
    setField(resolved.enabled, currentCase.enabled ?? true);
    setField(resolved.chatId, primaryChatId, { clearWithNull: true });
    setField(
      resolved.participantName,
      this.truncate(this.emptyToNull(currentCase.participantName), 200),
      { clearWithNull: true },
    );
    setField(resolved.managerName, this.truncate(this.emptyToNull(currentCase.managerName), 200), {
      clearWithNull: true,
    });
    setField(
      resolved.consultTime,
      typeof currentCase.consultTime === 'number' ? currentCase.consultTime : null,
      { clearWithNull: true },
    );
    setField(resolved.conversation, this.truncate(currentCase.conversation.trim(), 20000));
    setField(resolved.remark, this.truncate(remark, 8000), { clearWithNull: true });

    return fields;
  }

  private buildScenarioResetFields(
    resolved: ResolvedFieldNames<keyof typeof this.scenarioFieldAliases>,
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
    if (resolved.lastExecutionId) {
      fields[resolved.lastExecutionId] = null;
    }

    return fields;
  }

  private buildConversationResetFields(
    resolved: ResolvedFieldNames<keyof typeof this.conversationFieldAliases>,
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

  private async loadLineageTableContext(): Promise<LineageTableContext> {
    const { appToken, tableId } = this.bitableApi.getTableConfig('assetRelation');
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const resolved = this.resolveFieldNames(fields, this.lineageFieldAliases);

    this.ensureResolvedFields('资产关联', resolved, [
      'relationId',
      'sourceTable',
      'sourceAssetId',
      'targetTable',
      'targetAssetId',
      'enabled',
    ]);

    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);

    return {
      appToken,
      tableId,
      fieldNameToId,
      resolved,
      recordsByRelationId: this.buildRecordIndex(records, fieldNameToId, resolved.relationId),
      recordsByTargetKey: this.buildTargetRecordBuckets(
        records,
        fieldNameToId,
        resolved.targetTable,
        resolved.targetAssetId,
      ),
    };
  }

  private async syncTargetLineageRelations(
    context: LineageTableContext,
    desiredRelations: DesiredLineageRelation[],
    targetTable: LineageTargetTable,
    targetAssetId: string,
  ): Promise<void> {
    const targetKey = this.buildTargetKey(targetTable, targetAssetId);
    const existingForTarget = context.recordsByTargetKey.get(targetKey) || [];
    const desiredById = new Map(
      desiredRelations.map((relation) => [relation.relationId, relation]),
    );

    for (const relation of desiredRelations) {
      const existing = context.recordsByRelationId.get(relation.relationId);
      const payload = this.buildLineageFields(context.resolved, relation, false);

      if (!existing) {
        const result = await this.bitableApi.createRecord(
          context.appToken,
          context.tableId,
          this.stripNilFields(this.buildLineageFields(context.resolved, relation, true)),
        );
        this.upsertLineageRecordInContext(
          context,
          result.recordId,
          this.buildLineageFields(context.resolved, relation, true),
        );
        continue;
      }

      const changedFieldNames = this.getChangedFieldNames(existing, context.fieldNameToId, payload);
      if (changedFieldNames.length === 0) {
        this.upsertLineageRecordInContext(context, existing.record_id, payload);
        continue;
      }

      const result = await this.bitableApi.updateRecord(
        context.appToken,
        context.tableId,
        existing.record_id,
        this.buildLineageFields(context.resolved, relation, true),
      );

      if (!result.success) {
        throw new Error(
          `更新资产关联记录失败(relationId=${relation.relationId}): ${result.error || '未知错误'}`,
        );
      }

      this.upsertLineageRecordInContext(
        context,
        existing.record_id,
        this.buildLineageFields(context.resolved, relation, true),
      );
    }

    for (const staleRecord of existingForTarget) {
      const relationId = this.extractRecordField(
        staleRecord.fields,
        context.fieldNameToId,
        context.resolved.relationId!,
      );
      const normalizedRelationId = this.normalizeComparableValue(relationId);
      if (!normalizedRelationId || desiredById.has(String(normalizedRelationId))) {
        continue;
      }

      const deactivatePayload = this.buildLineageDeactivationFields(context.resolved);
      const changedFieldNames = this.getChangedFieldNames(
        staleRecord,
        context.fieldNameToId,
        deactivatePayload,
      );

      if (changedFieldNames.length === 0) {
        this.upsertLineageRecordInContext(
          context,
          staleRecord.record_id,
          this.buildLineageContextSnapshot(context, staleRecord, deactivatePayload),
        );
        continue;
      }

      const result = await this.bitableApi.updateRecord(
        context.appToken,
        context.tableId,
        staleRecord.record_id,
        deactivatePayload,
      );

      if (!result.success) {
        throw new Error(
          `失效旧资产关联记录失败(relationId=${String(normalizedRelationId)}): ${result.error || '未知错误'}`,
        );
      }

      this.upsertLineageRecordInContext(
        context,
        staleRecord.record_id,
        this.buildLineageContextSnapshot(context, staleRecord, deactivatePayload),
      );
    }
  }

  private buildScenarioLineageRelations(
    currentCase: CuratedScenarioCaseDto,
    targetRecordId: string,
    importNote?: string,
  ): DesiredLineageRelation[] {
    const stableTargetId = currentCase.caseId.trim();
    const targetTitle = currentCase.caseName.trim();
    const curatedSourceType = currentCase.sourceType || ScenarioDatasetSourceType.MANUAL;
    const syncedAt = Date.now();
    const remark = this.composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
    ]);

    return this.buildLineageRelationsFromSources(
      [
        {
          sourceTable: 'BadCase',
          sourceIds: currentCase.sourceBadCaseIds,
          relationRole: '问题来源',
        },
        {
          sourceTable: 'GoodCase',
          sourceIds: currentCase.sourceGoodCaseIds,
          relationRole: '正样本参考',
        },
        {
          sourceTable: 'Chat',
          sourceIds: currentCase.sourceChatIds,
          relationRole: '对话证据',
        },
      ],
      {
        targetTable: '测试集',
        targetAssetId: stableTargetId,
        targetTitle,
        targetRecordId,
        curatedSourceType,
        remark,
        syncedAt,
      },
    );
  }

  private buildConversationLineageRelations(
    currentCase: CuratedConversationCaseDto,
    targetRecordId: string,
    importNote?: string,
  ): DesiredLineageRelation[] {
    const stableTargetId = currentCase.validationId.trim();
    const targetTitle = currentCase.validationTitle.trim();
    const curatedSourceType = currentCase.sourceType || ConversationDatasetSourceType.PRODUCTION;
    const syncedAt = Date.now();
    const remark = this.composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
    ]);

    return this.buildLineageRelationsFromSources(
      [
        {
          sourceTable: 'BadCase',
          sourceIds: currentCase.sourceBadCaseIds,
          relationRole: '问题来源',
        },
        {
          sourceTable: 'GoodCase',
          sourceIds: currentCase.sourceGoodCaseIds,
          relationRole: '正样本参考',
        },
        {
          sourceTable: 'Chat',
          sourceIds: this.collectConversationChatIds(currentCase),
          relationRole: '对话证据',
        },
      ],
      {
        targetTable: '验证集',
        targetAssetId: stableTargetId,
        targetTitle,
        targetRecordId,
        curatedSourceType,
        remark,
        syncedAt,
      },
    );
  }

  private buildLineageRelationsFromSources(
    groups: Array<{
      sourceTable: LineageSourceTable;
      sourceIds?: string[];
      relationRole: LineageRelationRole;
    }>,
    target: Omit<
      DesiredLineageRelation,
      'relationId' | 'summary' | 'sourceTable' | 'sourceAssetId' | 'relationRole' | 'enabled'
    >,
  ): DesiredLineageRelation[] {
    const relations: DesiredLineageRelation[] = [];

    for (const group of groups) {
      const sourceIds = this.normalizeIds(group.sourceIds);
      for (const sourceAssetId of sourceIds) {
        relations.push({
          relationId: this.generateLineageRelationId(
            group.sourceTable,
            sourceAssetId,
            target.targetTable,
            target.targetAssetId,
            group.relationRole,
          ),
          summary: this.bitableApi.truncateText(
            `${group.sourceTable}:${sourceAssetId} -> ${target.targetTable}:${target.targetAssetId}`,
            500,
          ),
          sourceTable: group.sourceTable,
          sourceAssetId,
          targetTable: target.targetTable,
          targetAssetId: target.targetAssetId,
          targetTitle: target.targetTitle,
          targetRecordId: target.targetRecordId,
          relationRole: group.relationRole,
          curatedSourceType: target.curatedSourceType,
          enabled: true,
          remark: target.remark,
          syncedAt: target.syncedAt,
        });
      }
    }

    return relations;
  }

  private buildLineageFields(
    resolved: ResolvedFieldNames<LineageFieldKey>,
    relation: DesiredLineageRelation,
    includeSyncedAt = true,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    const setField = (
      fieldName: string | undefined,
      value: unknown,
      options?: { clearWithNull?: boolean },
    ) => {
      if (!fieldName) return;

      if (value === undefined || value === null) {
        if (options?.clearWithNull) {
          fields[fieldName] = null;
        }
        return;
      }

      fields[fieldName] = value;
    };

    setField(resolved.primaryText, relation.summary);
    setField(resolved.relationId, relation.relationId);
    setField(resolved.sourceTable, relation.sourceTable);
    setField(resolved.sourceAssetId, relation.sourceAssetId);
    setField(resolved.targetTable, relation.targetTable);
    setField(resolved.targetAssetId, relation.targetAssetId);
    setField(resolved.targetTitle, relation.targetTitle, { clearWithNull: true });
    setField(resolved.targetRecordId, relation.targetRecordId, { clearWithNull: true });
    setField(resolved.relationRole, relation.relationRole);
    setField(resolved.curatedSourceType, relation.curatedSourceType, { clearWithNull: true });
    setField(resolved.enabled, relation.enabled);
    setField(resolved.remark, this.truncate(relation.remark, 8000), { clearWithNull: true });
    if (includeSyncedAt) {
      setField(resolved.syncedAt, relation.syncedAt);
    }

    return fields;
  }

  private buildLineageDeactivationFields(
    resolved: ResolvedFieldNames<LineageFieldKey>,
  ): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    if (resolved.enabled) {
      fields[resolved.enabled] = false;
    }
    if (resolved.syncedAt) {
      fields[resolved.syncedAt] = Date.now();
    }

    return fields;
  }

  private buildTargetRecordBuckets(
    records: BitableRecord[],
    fieldNameToId: Record<string, string>,
    targetTableFieldName?: string,
    targetAssetIdFieldName?: string,
  ): Map<string, BitableRecord[]> {
    const buckets = new Map<string, BitableRecord[]>();
    if (!targetTableFieldName || !targetAssetIdFieldName) {
      return buckets;
    }

    for (const record of records) {
      const targetTable = this.extractRecordField(
        record.fields,
        fieldNameToId,
        targetTableFieldName,
      );
      const targetAssetId = this.extractRecordField(
        record.fields,
        fieldNameToId,
        targetAssetIdFieldName,
      );
      const normalizedTargetTable = this.normalizeComparableValue(targetTable);
      const normalizedTargetAssetId = this.normalizeComparableValue(targetAssetId);
      if (!normalizedTargetTable || !normalizedTargetAssetId) {
        continue;
      }

      const key = this.buildTargetKey(
        String(normalizedTargetTable) as LineageTargetTable,
        String(normalizedTargetAssetId),
      );
      const recordsForTarget = buckets.get(key) || [];
      recordsForTarget.push(record);
      buckets.set(key, recordsForTarget);
    }

    return buckets;
  }

  private upsertLineageRecordInContext(
    context: LineageTableContext,
    recordId: string,
    fields: Record<string, unknown>,
  ): void {
    const relationIdField = context.resolved.relationId;
    const targetTableField = context.resolved.targetTable;
    const targetAssetIdField = context.resolved.targetAssetId;
    if (!relationIdField || !targetTableField || !targetAssetIdField) {
      return;
    }

    const nextRecord: BitableRecord = {
      record_id: recordId,
      fields,
    };

    const relationId = this.normalizeComparableValue(fields[relationIdField]);
    if (relationId) {
      context.recordsByRelationId.set(String(relationId), nextRecord);
    }

    const targetTable = this.normalizeComparableValue(fields[targetTableField]);
    const targetAssetId = this.normalizeComparableValue(fields[targetAssetIdField]);
    if (targetTable && targetAssetId) {
      const bucketKey = this.buildTargetKey(
        String(targetTable) as LineageTargetTable,
        String(targetAssetId),
      );
      const bucket = (context.recordsByTargetKey.get(bucketKey) || []).filter(
        (record) => record.record_id !== recordId,
      );
      bucket.push(nextRecord);
      context.recordsByTargetKey.set(bucketKey, bucket);
    }
  }

  private buildLineageContextSnapshot(
    context: LineageTableContext,
    record: BitableRecord,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    const snapshot: Record<string, unknown> = { ...overrides };

    for (const fieldName of [
      context.resolved.relationId,
      context.resolved.sourceTable,
      context.resolved.sourceAssetId,
      context.resolved.targetTable,
      context.resolved.targetAssetId,
    ]) {
      if (!fieldName || snapshot[fieldName] !== undefined) {
        continue;
      }

      snapshot[fieldName] = this.extractRecordField(
        record.fields,
        context.fieldNameToId,
        fieldName,
      );
    }

    return snapshot;
  }

  private buildTargetKey(targetTable: LineageTargetTable, targetAssetId: string): string {
    return `${targetTable}::${targetAssetId}`;
  }

  private collectConversationChatIds(currentCase: CuratedConversationCaseDto): string[] {
    const values = [...(currentCase.sourceChatIds || [])];
    if (currentCase.chatId?.trim()) {
      values.unshift(currentCase.chatId.trim());
    }

    return this.normalizeIds(values);
  }

  private normalizeIds(values?: string[]): string[] {
    if (!values?.length) {
      return [];
    }

    return Array.from(
      new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
    );
  }

  private generateLineageRelationId(
    sourceTable: LineageSourceTable,
    sourceAssetId: string,
    targetTable: LineageTargetTable,
    targetAssetId: string,
    relationRole: LineageRelationRole,
  ): string {
    return `rel_${createHash('sha1')
      .update(`${sourceTable}|${sourceAssetId}|${targetTable}|${targetAssetId}|${relationRole}`)
      .digest('hex')
      .slice(0, 20)}`;
  }

  private resolveFieldNames<T extends Record<string, readonly string[]>>(
    fields: BitableField[],
    aliases: T,
  ): ResolvedFieldNames<Extract<keyof T, string>> {
    const existingFieldNames = new Set(fields.map((field) => field.field_name));
    const resolved: Partial<Record<Extract<keyof T, string>, string>> = {};

    for (const key of Object.keys(aliases) as Array<Extract<keyof T, string>>) {
      const matched = aliases[key].find((candidate) => existingFieldNames.has(candidate));
      if (matched) {
        resolved[key] = matched;
      }
    }

    return resolved;
  }

  private ensureResolvedFields<T extends string>(
    tableLabel: string,
    resolved: ResolvedFieldNames<T>,
    requiredKeys: T[],
  ): void {
    const missing = requiredKeys.filter((key) => !resolved[key]);
    if (missing.length > 0) {
      throw new Error(`${tableLabel} 缺少必要字段: ${missing.join(', ')}`);
    }
  }

  private buildRecordIndex(
    records: BitableRecord[],
    fieldNameToId: Record<string, string>,
    stableIdFieldName?: string,
  ): Map<string, BitableRecord> {
    const index = new Map<string, BitableRecord>();
    if (!stableIdFieldName) {
      return index;
    }

    for (const record of records) {
      const stableId = this.extractRecordField(record.fields, fieldNameToId, stableIdFieldName);
      const normalizedStableId = this.normalizeComparableValue(stableId);
      if (!normalizedStableId) {
        continue;
      }

      index.set(String(normalizedStableId), record);
    }

    return index;
  }

  private getChangedFieldNames(
    record: BitableRecord,
    fieldNameToId: Record<string, string>,
    desiredFields: Record<string, unknown>,
  ): string[] {
    return Object.entries(desiredFields)
      .filter(([fieldName, desiredValue]) => {
        const currentValue = this.extractRecordField(record.fields, fieldNameToId, fieldName);
        return !this.isSameValue(currentValue, desiredValue);
      })
      .map(([fieldName]) => fieldName);
  }

  private extractRecordField(
    recordFields: Record<string, unknown>,
    fieldNameToId: Record<string, string>,
    fieldName: string,
  ): unknown {
    const fieldId = fieldNameToId[fieldName];

    if (fieldId && recordFields[fieldId] !== undefined) {
      return recordFields[fieldId];
    }

    return recordFields[fieldName];
  }

  private isSameValue(left: unknown, right: unknown): boolean {
    return this.normalizeComparableValue(left) === this.normalizeComparableValue(right);
  }

  private normalizeComparableValue(value: unknown): string | number | boolean | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'string') {
      const normalized = value.trim();
      return normalized ? normalized : null;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      const normalized = value
        .map((item) => this.normalizeComparableValue(item))
        .filter((item): item is string | number | boolean => item !== null)
        .map((item) => String(item))
        .join('|');
      return normalized || null;
    }

    if (typeof value === 'object') {
      const candidate = value as Record<string, unknown>;
      if (candidate.text !== undefined) {
        return this.normalizeComparableValue(candidate.text);
      }
      if (candidate.name !== undefined) {
        return this.normalizeComparableValue(candidate.name);
      }
      if (candidate.value !== undefined) {
        return this.normalizeComparableValue(candidate.value);
      }
      return JSON.stringify(candidate);
    }

    return String(value);
  }

  private stripNilFields(fields: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
    );
  }

  private emptyToNull(value?: string): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.trim();
    return normalized || null;
  }

  private truncate(value: string | null | undefined, maxLength: number): string | null {
    if (!value) {
      return null;
    }

    return this.bitableApi.truncateText(value, maxLength);
  }

  private composeRemark(parts: Array<string | undefined>): string | null {
    const normalized = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
    return normalized.length > 0 ? normalized.join('\n') : null;
  }

  private joinIds(values?: string[]): string | null {
    if (!values?.length) {
      return null;
    }

    const normalized = Array.from(
      new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
    );

    return normalized.length > 0 ? normalized.join(', ') : null;
  }

  private firstId(values?: string[]): string | null {
    if (!values?.length) {
      return null;
    }

    for (const value of values) {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }
}
