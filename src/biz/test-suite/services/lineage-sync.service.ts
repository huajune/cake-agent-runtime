import { Injectable } from '@nestjs/common';
import { BitableRecord, FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import {
  ConversationDatasetSourceType,
  CuratedConversationCaseDto,
  CuratedScenarioCaseDto,
  ScenarioDatasetSourceType,
} from '../dto/test-chat.dto';
import {
  buildRecordIndex,
  composeRemark,
  ensureResolvedFields,
  extractRecordField,
  getChangedFieldNames,
  normalizeComparableValue,
  normalizeIds,
  resolveFieldNames,
  ResolvedFieldNames,
  setField,
  stripNilFields,
  truncate,
} from './curated-dataset-import.helpers';
import {
  buildLineageTargetKey,
  collectConversationChatIds,
  DesiredLineageRelation,
  generateLineageRelationId,
  LineageFieldKey,
  LineageRelationRole,
  LineageSourceTable,
  LineageTableContext,
  LineageTargetTable,
  lineageFieldAliases,
} from './lineage-sync.types';
import { normalizeSourceTrace } from './test-trace.helpers';

@Injectable()
export class LineageSyncService {
  constructor(private readonly bitableApi: FeishuBitableApiService) {}

  async loadLineageTableContext(): Promise<LineageTableContext> {
    const { appToken, tableId } = this.bitableApi.getTableConfig('assetRelation');
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const resolved = resolveFieldNames(fields, lineageFieldAliases);

    ensureResolvedFields('资产关联', resolved, [
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
      recordsByRelationId: buildRecordIndex(records, fieldNameToId, resolved.relationId),
      recordsByTargetKey: this.buildTargetRecordBuckets(
        records,
        fieldNameToId,
        resolved.targetTable,
        resolved.targetAssetId,
      ),
    };
  }

  async syncScenarioLineageRelations(
    context: LineageTableContext,
    currentCase: CuratedScenarioCaseDto,
    targetRecordId: string,
    importNote?: string,
  ): Promise<void> {
    await this.syncTargetLineageRelations(
      context,
      this.buildScenarioLineageRelations(currentCase, targetRecordId, importNote),
      '测试集',
      currentCase.caseId.trim(),
    );
  }

  async syncConversationLineageRelations(
    context: LineageTableContext,
    currentCase: CuratedConversationCaseDto,
    targetRecordId: string,
    importNote?: string,
  ): Promise<void> {
    await this.syncTargetLineageRelations(
      context,
      this.buildConversationLineageRelations(currentCase, targetRecordId, importNote),
      '验证集',
      currentCase.validationId.trim(),
    );
  }

  private async syncTargetLineageRelations(
    context: LineageTableContext,
    desiredRelations: DesiredLineageRelation[],
    targetTable: LineageTargetTable,
    targetAssetId: string,
  ): Promise<void> {
    const targetKey = buildLineageTargetKey(targetTable, targetAssetId);
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
          stripNilFields(this.buildLineageFields(context.resolved, relation, true)),
        );
        this.upsertLineageRecordInContext(
          context,
          result.recordId,
          this.buildLineageFields(context.resolved, relation, true),
        );
        continue;
      }

      const changedFieldNames = getChangedFieldNames(existing, context.fieldNameToId, payload);
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
      const relationId = extractRecordField(
        staleRecord.fields,
        context.fieldNameToId,
        context.resolved.relationId!,
      );
      const normalizedRelationId = normalizeComparableValue(relationId);
      if (
        normalizedRelationId === null ||
        normalizedRelationId === '' ||
        desiredById.has(String(normalizedRelationId))
      ) {
        continue;
      }

      const deactivatePayload = this.buildLineageDeactivationFields(context.resolved);
      const changedFieldNames = getChangedFieldNames(
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
    const sourceTrace = normalizeSourceTrace(currentCase);
    const remark = composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
    ]);

    return this.buildLineageRelationsFromSources(
      [
        {
          sourceTable: 'BadCase',
          sourceIds: normalizeIds([
            ...(currentCase.sourceBadCaseIds || []),
            ...(sourceTrace?.badcaseIds || []),
          ]),
          relationRole: '问题来源',
        },
        {
          sourceTable: 'GoodCase',
          sourceIds: normalizeIds([
            ...(currentCase.sourceGoodCaseIds || []),
            ...(sourceTrace?.goodcaseIds || []),
          ]),
          relationRole: '正样本参考',
        },
        {
          sourceTable: 'Chat',
          sourceIds: normalizeIds([
            ...(currentCase.sourceChatIds || []),
            ...(sourceTrace?.chatIds || []),
          ]),
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
    const sourceTrace = normalizeSourceTrace(currentCase);
    const remark = composeRemark([
      importNote ? `导入说明: ${importNote}` : undefined,
      currentCase.remark ? `策展备注: ${currentCase.remark.trim()}` : undefined,
    ]);

    return this.buildLineageRelationsFromSources(
      [
        {
          sourceTable: 'BadCase',
          sourceIds: normalizeIds([
            ...(currentCase.sourceBadCaseIds || []),
            ...(sourceTrace?.badcaseIds || []),
          ]),
          relationRole: '问题来源',
        },
        {
          sourceTable: 'GoodCase',
          sourceIds: normalizeIds([
            ...(currentCase.sourceGoodCaseIds || []),
            ...(sourceTrace?.goodcaseIds || []),
          ]),
          relationRole: '正样本参考',
        },
        {
          sourceTable: 'Chat',
          sourceIds: collectConversationChatIds(currentCase),
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
      const sourceIds = normalizeIds(group.sourceIds);
      for (const sourceAssetId of sourceIds) {
        relations.push({
          relationId: generateLineageRelationId(
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

    setField(fields, resolved.primaryText, relation.summary);
    setField(fields, resolved.relationId, relation.relationId);
    setField(fields, resolved.sourceTable, relation.sourceTable);
    setField(fields, resolved.sourceAssetId, relation.sourceAssetId);
    setField(fields, resolved.targetTable, relation.targetTable);
    setField(fields, resolved.targetAssetId, relation.targetAssetId);
    setField(fields, resolved.targetTitle, relation.targetTitle, { clearWithNull: true });
    setField(fields, resolved.targetRecordId, relation.targetRecordId, { clearWithNull: true });
    setField(fields, resolved.relationRole, relation.relationRole);
    setField(fields, resolved.curatedSourceType, relation.curatedSourceType, {
      clearWithNull: true,
    });
    setField(fields, resolved.enabled, relation.enabled);
    setField(fields, resolved.remark, this.truncate(relation.remark, 8000), {
      clearWithNull: true,
    });
    if (includeSyncedAt) {
      setField(fields, resolved.syncedAt, relation.syncedAt);
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
      const targetTable = extractRecordField(record.fields, fieldNameToId, targetTableFieldName);
      const targetAssetId = extractRecordField(
        record.fields,
        fieldNameToId,
        targetAssetIdFieldName,
      );
      const normalizedTargetTable = normalizeComparableValue(targetTable);
      const normalizedTargetAssetId = normalizeComparableValue(targetAssetId);
      if (
        normalizedTargetTable === null ||
        normalizedTargetTable === '' ||
        normalizedTargetAssetId === null ||
        normalizedTargetAssetId === ''
      ) {
        continue;
      }

      const key = buildLineageTargetKey(
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

    const relationId = normalizeComparableValue(fields[relationIdField]);
    if (relationId !== null && relationId !== '') {
      context.recordsByRelationId.set(String(relationId), nextRecord);
    }

    const targetTable = normalizeComparableValue(fields[targetTableField]);
    const targetAssetId = normalizeComparableValue(fields[targetAssetIdField]);
    if (
      targetTable !== null &&
      targetTable !== '' &&
      targetAssetId !== null &&
      targetAssetId !== ''
    ) {
      const bucketKey = buildLineageTargetKey(
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

      snapshot[fieldName] = extractRecordField(record.fields, context.fieldNameToId, fieldName);
    }

    return snapshot;
  }

  private truncate(value: string | null | undefined, maxLength: number): string | null {
    return truncate(this.bitableApi, value, maxLength);
  }
}
