import { Injectable, Logger } from '@nestjs/common';
import {
  BitableField,
  BitableRecord,
  FeishuBitableApiService,
} from '@infra/feishu/services/bitable-api.service';
import {
  CuratedDatasetImportFailure,
  CuratedDatasetImportResult,
  ImportCuratedConversationDatasetRequestDto,
  ImportCuratedScenarioDatasetRequestDto,
} from '../dto/test-chat.dto';
import { CuratedDatasetPayloadBuilderService } from './curated-dataset-payload-builder.service';
import {
  buildRecordIndex,
  getChangedFieldNames,
  stripNilFields,
} from './curated-dataset-import.helpers';
import { LineageSyncService } from './lineage-sync.service';

type CuratedDatasetImportOperation = 'created' | 'updated' | 'unchanged';

const BITABLE_FIELD_ALREADY_EXISTS_CODES = new Set([1254004]);

interface UpsertRecordResult {
  operation: CuratedDatasetImportOperation;
  recordId: string;
  fieldsSnapshot: Record<string, unknown>;
}

@Injectable()
export class CuratedDatasetImportService {
  private readonly logger = new Logger(CuratedDatasetImportService.name);

  constructor(
    private readonly bitableApi: FeishuBitableApiService,
    private readonly payloadBuilder: CuratedDatasetPayloadBuilderService,
    private readonly lineageSyncService: LineageSyncService,
  ) {}

  async importScenarioDataset(
    request: ImportCuratedScenarioDatasetRequestDto,
  ): Promise<CuratedDatasetImportResult> {
    if (!request.cases?.length) {
      throw new Error('测试集导入不能为空');
    }

    const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');
    let fields = await this.bitableApi.getFields(appToken, tableId);
    fields = await this.ensureTraceabilityFields(appToken, tableId, fields);
    const resolved = this.payloadBuilder.resolveScenarioFieldNames(fields);
    this.payloadBuilder.ensureScenarioRequiredFields(resolved);

    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);
    const existingByStableId = buildRecordIndex(records, fieldNameToId, resolved.stableId);
    const lineageContext = await this.lineageSyncService.loadLineageTableContext();

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const recordIds: string[] = [];
    const failures: CuratedDatasetImportFailure[] = [];

    for (const currentCase of request.cases) {
      const stableId = currentCase.caseId.trim();
      let targetRecordId: string | undefined;

      try {
        const upsertResult = await this.upsertRecord({
          appToken,
          tableId,
          stableId,
          stableIdLabel: 'caseId',
          datasetLabel: '测试集',
          existing: existingByStableId.get(stableId),
          fieldNameToId,
          desiredFields: this.payloadBuilder.buildScenarioFields(
            resolved,
            currentCase,
            request.importNote,
          ),
          resetFields: this.payloadBuilder.buildScenarioResetFields(resolved),
        });

        targetRecordId = upsertResult.recordId;

        existingByStableId.set(stableId, {
          record_id: targetRecordId,
          fields: upsertResult.fieldsSnapshot,
        });

        await this.lineageSyncService.syncScenarioLineageRelations(
          lineageContext,
          currentCase,
          targetRecordId,
          request.importNote,
        );

        ({ created, updated, unchanged } = this.applyOutcome(upsertResult.operation, {
          created,
          updated,
          unchanged,
        }));
        recordIds.push(targetRecordId);
      } catch (error) {
        failures.push(
          this.buildFailure(stableId, targetRecordId ? 'lineage' : 'upsert', error, targetRecordId),
        );
      }
    }

    return {
      created,
      updated,
      unchanged,
      failed: failures.length,
      total: request.cases.length,
      recordIds,
      failures,
    };
  }

  async importConversationDataset(
    request: ImportCuratedConversationDatasetRequestDto,
  ): Promise<CuratedDatasetImportResult> {
    if (!request.cases?.length) {
      throw new Error('验证集导入不能为空');
    }

    const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');
    let fields = await this.bitableApi.getFields(appToken, tableId);
    fields = await this.ensureTraceabilityFields(appToken, tableId, fields);
    const resolved = this.payloadBuilder.resolveConversationFieldNames(fields);
    this.payloadBuilder.ensureConversationRequiredFields(resolved);

    const fieldNameToId = this.bitableApi.buildFieldNameToIdMap(fields);
    const records = await this.bitableApi.getAllRecords(appToken, tableId);
    const existingByStableId = buildRecordIndex(records, fieldNameToId, resolved.stableId);
    const lineageContext = await this.lineageSyncService.loadLineageTableContext();

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const recordIds: string[] = [];
    const failures: CuratedDatasetImportFailure[] = [];

    for (const currentCase of request.cases) {
      const stableId = currentCase.validationId.trim();
      let targetRecordId: string | undefined;

      try {
        const upsertResult = await this.upsertRecord({
          appToken,
          tableId,
          stableId,
          stableIdLabel: 'validationId',
          datasetLabel: '验证集',
          existing: existingByStableId.get(stableId),
          fieldNameToId,
          desiredFields: this.payloadBuilder.buildConversationFields(
            resolved,
            currentCase,
            request.importNote,
          ),
          resetFields: this.payloadBuilder.buildConversationResetFields(resolved),
        });

        targetRecordId = upsertResult.recordId;

        existingByStableId.set(stableId, {
          record_id: targetRecordId,
          fields: upsertResult.fieldsSnapshot,
        });

        await this.lineageSyncService.syncConversationLineageRelations(
          lineageContext,
          currentCase,
          targetRecordId,
          request.importNote,
        );

        ({ created, updated, unchanged } = this.applyOutcome(upsertResult.operation, {
          created,
          updated,
          unchanged,
        }));
        recordIds.push(targetRecordId);
      } catch (error) {
        failures.push(
          this.buildFailure(stableId, targetRecordId ? 'lineage' : 'upsert', error, targetRecordId),
        );
      }
    }

    return {
      created,
      updated,
      unchanged,
      failed: failures.length,
      total: request.cases.length,
      recordIds,
      failures,
    };
  }

  private async upsertRecord(params: {
    appToken: string;
    tableId: string;
    stableId: string;
    stableIdLabel: 'caseId' | 'validationId';
    datasetLabel: '测试集' | '验证集';
    existing?: BitableRecord;
    fieldNameToId: Record<string, string>;
    desiredFields: Record<string, unknown>;
    resetFields: Record<string, unknown>;
  }): Promise<UpsertRecordResult> {
    const fullPayload = {
      ...params.desiredFields,
      ...params.resetFields,
    };

    if (!params.existing) {
      const result = await this.bitableApi.createRecord(
        params.appToken,
        params.tableId,
        stripNilFields(fullPayload),
      );
      return {
        recordId: result.recordId,
        operation: 'created',
        fieldsSnapshot: fullPayload,
      };
    }

    const changedFieldNames = getChangedFieldNames(
      params.existing,
      params.fieldNameToId,
      fullPayload,
    );

    if (changedFieldNames.length === 0) {
      return {
        recordId: params.existing.record_id,
        operation: 'unchanged',
        fieldsSnapshot: {
          ...params.existing.fields,
          ...fullPayload,
        },
      };
    }

    const result = await this.bitableApi.updateRecord(
      params.appToken,
      params.tableId,
      params.existing.record_id,
      fullPayload,
    );

    if (!result.success) {
      throw new Error(
        `更新${params.datasetLabel}记录失败(${params.stableIdLabel}=${params.stableId}): ${result.error || '未知错误'}`,
      );
    }

    this.logger.log(
      `${params.datasetLabel} upsert 更新: ${params.stableIdLabel}=${params.stableId}, recordId=${params.existing.record_id}, fields=${changedFieldNames.join(', ')}`,
    );

    return {
      recordId: params.existing.record_id,
      operation: 'updated',
      fieldsSnapshot: {
        ...params.existing.fields,
        ...fullPayload,
      },
    };
  }

  private applyOutcome(
    operation: CuratedDatasetImportOperation,
    counters: { created: number; updated: number; unchanged: number },
  ): { created: number; updated: number; unchanged: number } {
    if (operation === 'created') {
      return { ...counters, created: counters.created + 1 };
    }
    if (operation === 'updated') {
      return { ...counters, updated: counters.updated + 1 };
    }
    return { ...counters, unchanged: counters.unchanged + 1 };
  }

  private buildFailure(
    identifier: string,
    stage: 'upsert' | 'lineage',
    error: unknown,
    recordId?: string,
  ): CuratedDatasetImportFailure {
    const message = error instanceof Error ? error.message : String(error);
    const trace = error instanceof Error ? error.stack : undefined;
    this.logger.error(
      `策展数据导入失败: identifier=${identifier}, stage=${stage}, ${message}`,
      trace,
    );

    return {
      identifier,
      stage,
      message,
      recordId,
    };
  }

  private async ensureTraceabilityFields(
    appToken: string,
    tableId: string,
    fields: BitableField[],
  ): Promise<BitableField[]> {
    const specs = [
      { canonicalName: '来源BadCaseRecordID', aliases: ['来源RecordID', 'sourceRecordIds'] },
      { canonicalName: '触发MessageID', aliases: ['AnchorMessageID', 'sourceAnchorMessageIds'] },
      { canonicalName: '相关MessageID', aliases: ['RelatedMessageID', 'sourceRelatedMessageIds'] },
      {
        canonicalName: '处理流水ID',
        aliases: ['MessageProcessingID', 'sourceMessageProcessingIds'],
      },
      { canonicalName: 'TraceID', aliases: ['来源TraceID', 'sourceTraceIds'] },
      { canonicalName: 'SourceTrace', aliases: ['排障Trace', 'sourceTrace', '排障证据JSON'] },
      { canonicalName: 'MemorySetup', aliases: ['记忆前置', 'memorySetup'] },
      { canonicalName: 'MemoryAssertions', aliases: ['记忆断言', 'memoryAssertions'] },
    ];
    const existingNames = new Set(fields.map((field) => field.field_name));
    const nextFields = [...fields];

    for (const spec of specs) {
      const aliases = [spec.canonicalName, ...spec.aliases];
      if (aliases.some((alias) => existingNames.has(alias))) {
        continue;
      }

      try {
        const result = await this.bitableApi.createField(appToken, tableId, spec.canonicalName, 1);
        existingNames.add(spec.canonicalName);
        nextFields.push({
          field_id: result.fieldId,
          field_name: spec.canonicalName,
          type: 1,
        });
        this.logger.log(`已为策展数据集表 ${tableId} 创建可选字段: ${spec.canonicalName}`);
      } catch (error) {
        if (!this.isFieldAlreadyExistsError(error)) {
          throw error;
        }

        this.logger.warn(
          `策展数据集表 ${tableId} 可选字段已存在，刷新字段缓存后继续: ${spec.canonicalName}`,
        );
        const refreshedFields = await this.bitableApi.getFields(appToken, tableId);
        for (const field of refreshedFields) {
          if (!existingNames.has(field.field_name)) {
            existingNames.add(field.field_name);
            nextFields.push(field);
          }
        }
      }
    }

    return nextFields;
  }

  private isFieldAlreadyExistsError(error: unknown): boolean {
    const errorLike = error as {
      code?: unknown;
      feishuCode?: unknown;
      response?: { data?: { code?: unknown; msg?: unknown } };
      message?: string;
    };
    const codes = [errorLike?.code, errorLike?.feishuCode, errorLike?.response?.data?.code]
      .map((code) => Number(code))
      .filter((code) => Number.isFinite(code));

    if (codes.some((code) => BITABLE_FIELD_ALREADY_EXISTS_CODES.has(code))) {
      return true;
    }

    const message = [errorLike?.message, errorLike?.response?.data?.msg, String(error)]
      .filter(Boolean)
      .join(' ');
    return /field already exists|字段已存在|already exists/i.test(message);
  }
}
