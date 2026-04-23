import { Injectable, Logger } from '@nestjs/common';
import { BitableRecord, FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
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
    const fields = await this.bitableApi.getFields(appToken, tableId);
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
    const fields = await this.bitableApi.getFields(appToken, tableId);
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
}
