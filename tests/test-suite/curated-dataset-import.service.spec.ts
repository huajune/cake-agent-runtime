import { Test, TestingModule } from '@nestjs/testing';
import { CuratedDatasetImportService } from '@biz/test-suite/services/curated-dataset-import.service';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import { CuratedDatasetPayloadBuilderService } from '@biz/test-suite/services/curated-dataset-payload-builder.service';
import { LineageSyncService } from '@biz/test-suite/services/lineage-sync.service';

describe('CuratedDatasetImportService', () => {
  let service: CuratedDatasetImportService;
  let mockBitableApi: jest.Mocked<FeishuBitableApiService>;
  let mockPayloadBuilder: jest.Mocked<CuratedDatasetPayloadBuilderService>;
  let mockLineageSyncService: jest.Mocked<LineageSyncService>;

  beforeEach(async () => {
    mockBitableApi = {
      getTableConfig: jest.fn().mockReturnValue({
        appToken: 'app_test_suite',
        tableId: 'tbl_test_suite',
      }),
      getFields: jest.fn().mockResolvedValue([]),
      buildFieldNameToIdMap: jest.fn().mockReturnValue({}),
      getAllRecords: jest.fn().mockResolvedValue([]),
      createField: jest.fn().mockResolvedValue({ fieldId: 'fld-created' }),
      createRecord: jest.fn(),
      updateRecord: jest.fn(),
    } as unknown as jest.Mocked<FeishuBitableApiService>;

    mockPayloadBuilder = {
      resolveScenarioFieldNames: jest.fn().mockReturnValue({
        stableId: 'caseId',
      }),
      ensureScenarioRequiredFields: jest.fn(),
      buildScenarioFields: jest.fn((_, currentCase) => ({
        caseId: currentCase.caseId,
        标题: currentCase.caseName,
      })),
      buildScenarioResetFields: jest.fn().mockReturnValue({}),
      resolveConversationFieldNames: jest.fn(),
      ensureConversationRequiredFields: jest.fn(),
      buildConversationFields: jest.fn(),
      buildConversationResetFields: jest.fn(),
    } as unknown as jest.Mocked<CuratedDatasetPayloadBuilderService>;

    mockLineageSyncService = {
      loadLineageTableContext: jest.fn().mockResolvedValue({
        appToken: 'app_lineage',
        tableId: 'tbl_lineage',
        fieldNameToId: {},
        resolved: {},
        recordsByRelationId: new Map(),
        recordsByTargetKey: new Map(),
      }),
      syncScenarioLineageRelations: jest.fn().mockResolvedValue(undefined),
      syncConversationLineageRelations: jest.fn(),
    } as unknown as jest.Mocked<LineageSyncService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CuratedDatasetImportService,
        { provide: FeishuBitableApiService, useValue: mockBitableApi },
        { provide: CuratedDatasetPayloadBuilderService, useValue: mockPayloadBuilder },
        { provide: LineageSyncService, useValue: mockLineageSyncService },
      ],
    }).compile();

    service = module.get<CuratedDatasetImportService>(CuratedDatasetImportService);
  });

  it('continues importing remaining cases after a per-item upsert failure', async () => {
    mockBitableApi.createRecord
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce({ recordId: 'rec-2' });

    const result = await service.importScenarioDataset({
      cases: [
        {
          caseId: 'case-1',
          caseName: '第一条',
          userMessage: '你好',
        },
        {
          caseId: 'case-2',
          caseName: '第二条',
          userMessage: '您好',
        },
      ],
    });

    expect(result).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      failed: 1,
      total: 2,
      recordIds: ['rec-2'],
      failures: [
        {
          identifier: 'case-1',
          stage: 'upsert',
          message: 'create failed',
          recordId: undefined,
        },
      ],
    });
    expect(mockBitableApi.createRecord).toHaveBeenCalledTimes(2);
    expect(mockLineageSyncService.syncScenarioLineageRelations).toHaveBeenCalledTimes(1);
  });

  it('records lineage failures without aborting the full batch', async () => {
    mockBitableApi.createRecord.mockResolvedValue({ recordId: 'rec-1' });
    mockLineageSyncService.syncScenarioLineageRelations.mockRejectedValue(
      new Error('lineage failed'),
    );

    const result = await service.importScenarioDataset({
      cases: [
        {
          caseId: 'case-1',
          caseName: '第一条',
          userMessage: '你好',
        },
      ],
    });

    expect(result).toEqual({
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 1,
      total: 1,
      recordIds: [],
      failures: [
        {
          identifier: 'case-1',
          stage: 'lineage',
          message: 'lineage failed',
          recordId: 'rec-1',
        },
      ],
    });
  });
});
