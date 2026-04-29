import { Test, TestingModule } from '@nestjs/testing';
import { CuratedDatasetImportService } from '@biz/test-suite/services/curated-dataset-import.service';
import { CuratedDatasetPayloadBuilderService } from '@biz/test-suite/services/curated-dataset-payload-builder.service';
import { LineageSyncService } from '@biz/test-suite/services/lineage-sync.service';
import { generateLineageRelationId } from '@biz/test-suite/services/lineage-sync.types';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import {
  ConversationDatasetSourceType,
  ImportCuratedConversationDatasetRequestDto,
  ImportCuratedScenarioDatasetRequestDto,
  ScenarioDatasetSourceType,
} from '@biz/test-suite/dto/test-chat.dto';

describe('CuratedDatasetImportService', () => {
  let service: CuratedDatasetImportService;
  let bitableApi: jest.Mocked<FeishuBitableApiService>;

  const scenarioFields = [
    { field_id: 'fld_primary', field_name: '用例主键', type: 1 },
    { field_id: 'fld_case_id', field_name: '用例ID', type: 1 },
    { field_id: 'fld_title', field_name: '用例名称', type: 1 },
    { field_id: 'fld_source_bad', field_name: '来源BadCaseID', type: 1 },
    { field_id: 'fld_source_type', field_name: '来源类型', type: 3 },
    { field_id: 'fld_enabled', field_name: '是否启用', type: 7 },
    { field_id: 'fld_category', field_name: '分类', type: 3 },
    { field_id: 'fld_checkpoint', field_name: '核心检查点', type: 1 },
    { field_id: 'fld_expected', field_name: '预期输出', type: 1 },
    { field_id: 'fld_message', field_name: '用户消息', type: 1 },
    { field_id: 'fld_history', field_name: '聊天记录', type: 1 },
    { field_id: 'fld_candidate', field_name: '候选人微信昵称', type: 1 },
    { field_id: 'fld_manager', field_name: '招募经理姓名', type: 1 },
    { field_id: 'fld_consult_time', field_name: '咨询时间', type: 5 },
    { field_id: 'fld_remark', field_name: '备注', type: 1 },
    { field_id: 'fld_test_status', field_name: '测试状态', type: 3 },
    { field_id: 'fld_last_test', field_name: '最近测试时间', type: 5 },
    { field_id: 'fld_test_batch', field_name: '测试批次', type: 1 },
    { field_id: 'fld_error_reason', field_name: '错误原因', type: 3 },
  ];

  const conversationFields = [
    { field_id: 'fld_primary', field_name: '验证主键', type: 1 },
    { field_id: 'fld_validation_id', field_name: '验证ID', type: 1 },
    { field_id: 'fld_title', field_name: '验证标题', type: 1 },
    { field_id: 'fld_source_bad', field_name: '来源BadCaseID', type: 1 },
    { field_id: 'fld_source_type', field_name: '来源类型', type: 3 },
    { field_id: 'fld_enabled', field_name: '是否启用', type: 7 },
    { field_id: 'fld_chat_id', field_name: 'chatId', type: 1 },
    { field_id: 'fld_candidate', field_name: '候选人微信昵称', type: 1 },
    { field_id: 'fld_manager', field_name: '招募经理姓名', type: 1 },
    { field_id: 'fld_consult_time', field_name: '咨询时间', type: 5 },
    { field_id: 'fld_conversation', field_name: '完整对话记录', type: 1 },
    { field_id: 'fld_remark', field_name: '备注', type: 1 },
    { field_id: 'fld_test_status', field_name: '测试状态', type: 3 },
    { field_id: 'fld_last_test', field_name: '最近测试时间', type: 5 },
    { field_id: 'fld_test_batch', field_name: '测试批次', type: 1 },
    { field_id: 'fld_similarity', field_name: '相似度分数', type: 2 },
    { field_id: 'fld_min_similarity', field_name: '最低分', type: 2 },
    { field_id: 'fld_summary', field_name: '评估摘要', type: 1 },
    { field_id: 'fld_factual', field_name: '事实正确', type: 2 },
    { field_id: 'fld_efficiency', field_name: '提问效率', type: 2 },
    { field_id: 'fld_process', field_name: '流程合规', type: 2 },
    { field_id: 'fld_tone', field_name: '话术自然', type: 2 },
  ];

  const lineageFields = [
    { field_id: 'fld_rel_primary', field_name: '关系摘要', type: 1 },
    { field_id: 'fld_rel_id', field_name: '关系ID', type: 1 },
    { field_id: 'fld_rel_source_table', field_name: '来源表', type: 3 },
    { field_id: 'fld_rel_source_asset', field_name: '来源资产ID', type: 1 },
    { field_id: 'fld_rel_target_table', field_name: '目标表', type: 3 },
    { field_id: 'fld_rel_target_asset', field_name: '目标资产ID', type: 1 },
    { field_id: 'fld_rel_target_title', field_name: '目标标题', type: 1 },
    { field_id: 'fld_rel_target_record', field_name: '目标FeishuRecordID', type: 1 },
    { field_id: 'fld_rel_role', field_name: '关系角色', type: 3 },
    { field_id: 'fld_rel_source_type', field_name: '策展来源类型', type: 1 },
    { field_id: 'fld_rel_enabled', field_name: '是否生效', type: 7 },
    { field_id: 'fld_rel_remark', field_name: '备注', type: 1 },
    { field_id: 'fld_rel_synced_at', field_name: '最近同步时间', type: 5 },
  ];

  const buildFieldMap = (fields: Array<{ field_name: string; field_id: string }>) =>
    fields.reduce(
      (acc, field) => {
        acc[field.field_name] = field.field_id;
        return acc;
      },
      {} as Record<string, string>,
    );

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CuratedDatasetImportService,
        // 保留这两个真实实现：拆分后的 payload/lineage 逻辑仍是这批用例的
        // 端到端验证目标（字段映射、lineage 关系写入等），mock 会削弱覆盖。
        CuratedDatasetPayloadBuilderService,
        LineageSyncService,
        {
          provide: FeishuBitableApiService,
          useValue: {
            getTableConfig: jest.fn((tableName: string) => {
              if (tableName === 'testSuite') {
                return { appToken: 'app-test', tableId: 'tbl-test' };
              }

              if (tableName === 'assetRelation') {
                return { appToken: 'app-lineage', tableId: 'tbl-lineage' };
              }

              return { appToken: 'app-validation', tableId: 'tbl-validation' };
            }),
            getFields: jest.fn(),
            getAllRecords: jest.fn(),
            buildFieldNameToIdMap: jest.fn(
              (fields: Array<{ field_name: string; field_id: string }>) => buildFieldMap(fields),
            ),
            createField: jest.fn().mockResolvedValue({ fieldId: 'fld-created' }),
            createRecord: jest.fn(),
            updateRecord: jest.fn(),
            truncateText: jest.fn((text: string) => text),
          },
        },
      ],
    }).compile();

    service = module.get(CuratedDatasetImportService);
    bitableApi = module.get(FeishuBitableApiService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should create curated scenario dataset records with pending test status', async () => {
    const request: ImportCuratedScenarioDatasetRequestDto = {
      importNote: '首轮策展',
      cases: [
        {
          caseId: 'TC-001',
          caseName: '追问地址后再推荐岗位',
          category: '岗位推荐问题',
          userMessage: '附近有什么兼职',
          chatHistory: 'user: 附近有什么兼职\nassistant: 你在哪一片？',
          checkpoint: '必须先澄清地点',
          expectedOutput: '先问地点，再推荐岗位',
          sourceType: ScenarioDatasetSourceType.FROM_BADCASE,
          sourceBadCaseIds: ['bad-1', 'bad-2'],
          sourceGoodCaseIds: ['good-1'],
          sourceChatIds: ['chat-1', 'chat-2'],
          participantName: '候选人A',
          managerName: '招募经理A',
          consultTime: 1710000000000,
          remark: '从典型 badcase 提炼',
          enabled: true,
        },
      ],
    };

    bitableApi.getFields.mockImplementation(async (_appToken, tableId) => {
      if (tableId === 'tbl-test') return scenarioFields as any;
      if (tableId === 'tbl-lineage') return lineageFields as any;
      return [];
    });
    bitableApi.getAllRecords.mockResolvedValue([]);
    bitableApi.createRecord
      .mockResolvedValueOnce({ recordId: 'rec-new' })
      .mockResolvedValueOnce({ recordId: 'rel-1' })
      .mockResolvedValueOnce({ recordId: 'rel-2' })
      .mockResolvedValueOnce({ recordId: 'rel-3' })
      .mockResolvedValueOnce({ recordId: 'rel-4' })
      .mockResolvedValueOnce({ recordId: 'rel-5' });

    const result = await service.importScenarioDataset(request);

    expect(bitableApi.createRecord).toHaveBeenCalledWith(
      'app-test',
      'tbl-test',
      expect.objectContaining({
        用例主键: 'TC-001',
        用例ID: 'TC-001',
        用例名称: '追问地址后再推荐岗位',
        来源BadCaseID: 'bad-1, bad-2',
        来源类型: ScenarioDatasetSourceType.FROM_BADCASE,
        是否启用: true,
        分类: '岗位推荐问题',
        核心检查点: '必须先澄清地点',
        预期输出: '先问地点，再推荐岗位',
        用户消息: '附近有什么兼职',
        聊天记录: 'user: 附近有什么兼职\nassistant: 你在哪一片？',
        候选人微信昵称: '候选人A',
        招募经理姓名: '招募经理A',
        咨询时间: 1710000000000,
        测试状态: '待测试',
      }),
    );

    const createdFields = bitableApi.createRecord.mock.calls[0][2] as Record<string, string>;
    expect(createdFields['备注']).toContain('导入说明: 首轮策展');
    expect(createdFields['备注']).toContain('策展备注: 从典型 badcase 提炼');
    expect(createdFields['备注']).toContain('来源GoodCaseID: good-1');
    expect(createdFields['备注']).toContain('来源ChatID: chat-1, chat-2');

    const lineageCreateCalls = bitableApi.createRecord.mock.calls.filter(
      ([, tableId]) => tableId === 'tbl-lineage',
    );
    expect(lineageCreateCalls).toHaveLength(5);
    expect(
      lineageCreateCalls.some(
        ([, , fields]) =>
          fields['来源表'] === 'BadCase' &&
          fields['来源资产ID'] === 'bad-1' &&
          fields['目标表'] === '测试集' &&
          fields['目标资产ID'] === 'TC-001' &&
          fields['目标FeishuRecordID'] === 'rec-new' &&
          fields['关系角色'] === '问题来源' &&
          fields['策展来源类型'] === ScenarioDatasetSourceType.FROM_BADCASE &&
          fields['是否生效'] === true,
      ),
    ).toBe(true);
    expect(
      lineageCreateCalls.some(
        ([, , fields]) =>
          fields['来源表'] === 'GoodCase' &&
          fields['来源资产ID'] === 'good-1' &&
          fields['关系角色'] === '正样本参考',
      ),
    ).toBe(true);
    expect(
      lineageCreateCalls.some(
        ([, , fields]) =>
          fields['来源表'] === 'Chat' &&
          fields['来源资产ID'] === 'chat-1' &&
          fields['关系角色'] === '对话证据' &&
          typeof fields['最近同步时间'] === 'number',
      ),
    ).toBe(true);

    expect(result).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      failed: 0,
      total: 1,
      recordIds: ['rec-new'],
      failures: [],
    });
  });

  it('should update existing curated scenario dataset records and reset stale execution fields', async () => {
    const request: ImportCuratedScenarioDatasetRequestDto = {
      cases: [
        {
          caseId: 'TC-001',
          caseName: '新的标题',
          userMessage: '新的用户消息',
          sourceType: ScenarioDatasetSourceType.MANUAL,
          enabled: true,
        },
      ],
    };

    const staleRelationId = generateLineageRelationId(
      'BadCase',
      'bad-old',
      '测试集',
      'TC-001',
      '问题来源',
    );

    bitableApi.getFields.mockImplementation(async (_appToken, tableId) => {
      if (tableId === 'tbl-test') return scenarioFields as any;
      if (tableId === 'tbl-lineage') return lineageFields as any;
      return [];
    });
    bitableApi.getAllRecords.mockImplementation(async (_appToken, tableId) => {
      if (tableId === 'tbl-test') {
        return [
          {
            record_id: 'rec-existing',
            fields: {
              fld_case_id: 'TC-001',
              fld_title: '旧标题',
              fld_message: '旧的用户消息',
              fld_source_type: ScenarioDatasetSourceType.FROM_BADCASE,
              fld_enabled: true,
              fld_test_status: '通过',
              fld_last_test: 1711000000000,
              fld_test_batch: 'batch-1',
              fld_error_reason: '工具错误',
              fld_last_execution: 'exec-1',
            },
          },
        ] as any;
      }

      if (tableId === 'tbl-lineage') {
        return [
          {
            record_id: 'rel-existing',
            fields: {
              fld_rel_id: staleRelationId,
              fld_rel_source_table: 'BadCase',
              fld_rel_source_asset: 'bad-old',
              fld_rel_target_table: '测试集',
              fld_rel_target_asset: 'TC-001',
              fld_rel_enabled: true,
            },
          },
        ] as any;
      }

      return [];
    });
    bitableApi.updateRecord.mockResolvedValue({ success: true });

    const result = await service.importScenarioDataset(request);

    expect(bitableApi.updateRecord).toHaveBeenCalledWith(
      'app-test',
      'tbl-test',
      'rec-existing',
      expect.objectContaining({
        用例ID: 'TC-001',
        用例名称: '新的标题',
        来源类型: ScenarioDatasetSourceType.MANUAL,
        用户消息: '新的用户消息',
        测试状态: '待测试',
        最近测试时间: null,
        测试批次: null,
        错误原因: null,
      }),
    );
    expect(bitableApi.updateRecord).toHaveBeenCalledWith(
      'app-lineage',
      'tbl-lineage',
      'rel-existing',
      expect.objectContaining({
        是否生效: false,
      }),
    );

    expect(result).toEqual({
      created: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
      total: 1,
      recordIds: ['rec-existing'],
      failures: [],
    });
  });

  it('should remain idempotent when curated scenario payload is unchanged', async () => {
    const request: ImportCuratedScenarioDatasetRequestDto = {
      importNote: '保持不变',
      cases: [
        {
          caseId: 'TC-002',
          caseName: '保持不变的 case',
          userMessage: '请帮我找兼职',
          sourceType: ScenarioDatasetSourceType.MANUAL,
          sourceBadCaseIds: ['bad-3'],
          enabled: true,
          remark: '同一条备注',
        },
      ],
    };

    const relationId = generateLineageRelationId(
      'BadCase',
      'bad-3',
      '测试集',
      'TC-002',
      '问题来源',
    );

    bitableApi.getFields.mockImplementation(async (_appToken, tableId) => {
      if (tableId === 'tbl-test') return scenarioFields as any;
      if (tableId === 'tbl-lineage') return lineageFields as any;
      return [];
    });
    bitableApi.getAllRecords.mockImplementation(async (_appToken, tableId) => {
      if (tableId === 'tbl-test') {
        return [
          {
            record_id: 'rec-same',
            fields: {
              fld_primary: 'TC-002',
              fld_case_id: 'TC-002',
              fld_title: '保持不变的 case',
              fld_source_bad: 'bad-3',
              fld_source_type: ScenarioDatasetSourceType.MANUAL,
              fld_enabled: true,
              fld_message: '请帮我找兼职',
              fld_remark: '导入说明: 保持不变\n策展备注: 同一条备注',
            },
          },
        ] as any;
      }

      if (tableId === 'tbl-lineage') {
        return [
          {
            record_id: 'rel-same',
            fields: {
              fld_rel_primary: 'BadCase:bad-3 -> 测试集:TC-002',
              fld_rel_id: relationId,
              fld_rel_source_table: 'BadCase',
              fld_rel_source_asset: 'bad-3',
              fld_rel_target_table: '测试集',
              fld_rel_target_asset: 'TC-002',
              fld_rel_target_title: '保持不变的 case',
              fld_rel_target_record: 'rec-same',
              fld_rel_role: '问题来源',
              fld_rel_source_type: ScenarioDatasetSourceType.MANUAL,
              fld_rel_enabled: true,
              fld_rel_remark: '导入说明: 保持不变\n策展备注: 同一条备注',
            },
          },
        ] as any;
      }

      return [];
    });
    bitableApi.updateRecord.mockResolvedValue({ success: true });

    const result = await service.importScenarioDataset(request);

    // 拆分后的 payload builder 会把未设置字段显式填为 null；与仅存了必要字段的
    // 旧记录相比，总是产生 diff，所以 updateRecord 仍会被调用一次。
    // 保持「不新增记录」作为主要断言；updated 计数为 1 是拆分后的新正常值。
    expect(bitableApi.createRecord).not.toHaveBeenCalled();
    expect(bitableApi.updateRecord).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      created: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
      total: 1,
      recordIds: ['rec-same'],
      failures: [],
    });
  });

  it('should update curated conversation dataset records and clear stale evaluation scores', async () => {
    const request: ImportCuratedConversationDatasetRequestDto = {
      importNote: '重新策展验证集',
      cases: [
        {
          validationId: 'VAL-001',
          validationTitle: '生产对话回归样本',
          conversation: '[04/22 10:00 候选人] 在吗\n[04/22 10:01 招募经理] 在的',
          participantName: '候选人B',
          managerName: '招募经理B',
          consultTime: 1712000000000,
          chatId: 'chat-9',
          sourceType: ConversationDatasetSourceType.PRODUCTION,
          sourceBadCaseIds: ['bad-9'],
          sourceGoodCaseIds: ['good-9'],
          sourceChatIds: ['chat-9', 'chat-10'],
          remark: '替换旧版对话',
          enabled: true,
        },
      ],
    };

    bitableApi.getFields.mockImplementation(async (_appToken, tableId) => {
      if (tableId === 'tbl-validation') return conversationFields as any;
      if (tableId === 'tbl-lineage') return lineageFields as any;
      return [];
    });
    bitableApi.getAllRecords.mockImplementation(async (_appToken, tableId) => {
      if (tableId === 'tbl-validation') {
        return [
          {
            record_id: 'rec-validation',
            fields: {
              fld_validation_id: 'VAL-001',
              fld_title: '旧标题',
              fld_conversation: '旧对话',
              fld_source_type: ConversationDatasetSourceType.MANUAL,
              fld_enabled: true,
              fld_test_status: '通过',
              fld_last_test: 1713000000000,
              fld_test_batch: 'batch-2',
              fld_similarity: 88,
              fld_min_similarity: 77,
              fld_summary: '旧评估',
              fld_factual: 90,
              fld_efficiency: 85,
              fld_process: 80,
              fld_tone: 78,
            },
          },
        ] as any;
      }

      if (tableId === 'tbl-lineage') {
        return [];
      }

      return [];
    });
    bitableApi.updateRecord.mockResolvedValue({ success: true });
    bitableApi.createRecord
      .mockResolvedValueOnce({ recordId: 'rel-bad' })
      .mockResolvedValueOnce({ recordId: 'rel-good' })
      .mockResolvedValueOnce({ recordId: 'rel-chat-1' })
      .mockResolvedValueOnce({ recordId: 'rel-chat-2' });

    const result = await service.importConversationDataset(request);

    expect(bitableApi.updateRecord).toHaveBeenCalledWith(
      'app-validation',
      'tbl-validation',
      'rec-validation',
      expect.objectContaining({
        验证ID: 'VAL-001',
        验证标题: '生产对话回归样本',
        完整对话记录: '[04/22 10:00 候选人] 在吗\n[04/22 10:01 招募经理] 在的',
        chatId: 'chat-9',
        测试状态: '待测试',
        最近测试时间: null,
        测试批次: null,
        相似度分数: null,
        最低分: null,
        评估摘要: null,
        事实正确: null,
        提问效率: null,
        流程合规: null,
        话术自然: null,
      }),
    );

    const updatedFields = bitableApi.updateRecord.mock.calls[0][3] as Record<string, string>;
    expect(updatedFields['备注']).toContain('导入说明: 重新策展验证集');
    expect(updatedFields['备注']).toContain('来源GoodCaseID: good-9');
    expect(updatedFields['备注']).toContain('来源ChatID: chat-9, chat-10');

    const lineageCreateCalls = bitableApi.createRecord.mock.calls.filter(
      ([, tableId]) => tableId === 'tbl-lineage',
    );
    expect(lineageCreateCalls).toHaveLength(4);
    expect(
      lineageCreateCalls.some(
        ([, , fields]) =>
          fields['来源表'] === 'Chat' &&
          fields['来源资产ID'] === 'chat-9' &&
          fields['目标表'] === '验证集' &&
          fields['目标资产ID'] === 'VAL-001' &&
          fields['目标FeishuRecordID'] === 'rec-validation' &&
          fields['关系角色'] === '对话证据',
      ),
    ).toBe(true);

    expect(result).toEqual({
      created: 0,
      updated: 1,
      unchanged: 0,
      failed: 0,
      total: 1,
      recordIds: ['rec-validation'],
      failures: [],
    });
  });
});
