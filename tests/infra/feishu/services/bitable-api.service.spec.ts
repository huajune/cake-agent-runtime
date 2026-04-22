import { Test, TestingModule } from '@nestjs/testing';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import { FeishuApiService } from '@infra/feishu/services/api.service';

describe('FeishuBitableApiService', () => {
  let service: FeishuBitableApiService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFeishuApi: any;

  beforeEach(async () => {
    mockFeishuApi = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeishuBitableApiService, { provide: FeishuApiService, useValue: mockFeishuApi }],
    }).compile();

    service = module.get<FeishuBitableApiService>(FeishuBitableApiService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getTableConfig', () => {
    it('should return chat table config', () => {
      const config = service.getTableConfig('chat');
      expect(config).toBeDefined();
      expect(config.appToken).toBeDefined();
      expect(config.tableId).toBeDefined();
    });

    it('should return badcase table config', () => {
      const config = service.getTableConfig('badcase');
      expect(config).toBeDefined();
      expect(config.appToken).toBeDefined();
      expect(config.tableId).toBeDefined();
    });

    it('should return goodcase table config', () => {
      const config = service.getTableConfig('goodcase');
      expect(config).toBeDefined();
    });

    it('should return testSuite table config', () => {
      const config = service.getTableConfig('testSuite');
      expect(config).toBeDefined();
    });

    it('should return validationSet table config', () => {
      const config = service.getTableConfig('validationSet');
      expect(config).toBeDefined();
    });

    it('should return assetRelation table config', () => {
      const config = service.getTableConfig('assetRelation');
      expect(config).toBeDefined();
    });
  });

  describe('getFields', () => {
    it('should return fields on success', async () => {
      const fields = [
        { field_id: 'fld_001', field_name: '候选人', type: 1 },
        { field_id: 'fld_002', field_name: '招募经理', type: 1 },
      ];
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 0, msg: 'success', data: { items: fields } },
      });

      const result = await service.getFields('appToken', 'tableId');
      expect(result).toEqual(fields);
      expect(mockFeishuApi.get).toHaveBeenCalledWith(
        '/bitable/v1/apps/appToken/tables/tableId/fields',
      );
    });

    it('should throw error when API returns non-zero code', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 99991663, msg: 'app token not found' },
      });

      await expect(service.getFields('invalid', 'tableId')).rejects.toThrow(
        '获取表格字段失败: app token not found',
      );
    });

    it('should return empty array when items is missing', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 0, msg: 'success', data: {} },
      });

      const result = await service.getFields('appToken', 'tableId');
      expect(result).toEqual([]);
    });
  });

  describe('createField', () => {
    it('should create a text field successfully', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: {
          code: 0,
          msg: 'success',
          data: { field: { field_id: 'fld_new', field_name: '新字段' } },
        },
      });

      const result = await service.createField('appToken', 'tableId', '新字段', 1);
      expect(result.fieldId).toBe('fld_new');
    });

    it('should create a single-select field with options', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: {
          code: 0,
          msg: 'success',
          data: { field: { field_id: 'fld_select', field_name: '状态' } },
        },
      });

      const result = await service.createField('appToken', 'tableId', '状态', 3, [
        '进行中',
        '完成',
      ]);
      expect(result.fieldId).toBe('fld_select');

      const callBody = mockFeishuApi.post.mock.calls[0][1] as Record<string, unknown>;
      expect(callBody.property).toBeDefined();
      expect((callBody.property as any).options).toHaveLength(2);
    });

    it('should not include property for non-select field types', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: {
          code: 0,
          msg: 'success',
          data: { field: { field_id: 'fld_text', field_name: '文本' } },
        },
      });

      await service.createField('appToken', 'tableId', '文本', 1, ['option1']);
      const callBody = mockFeishuApi.post.mock.calls[0][1] as Record<string, unknown>;
      expect(callBody.property).toBeUndefined();
    });

    it('should throw error when API returns non-zero code', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 1254004, msg: 'field already exists' },
      });

      await expect(service.createField('appToken', 'tableId', '字段', 1)).rejects.toThrow(
        '创建字段失败: field already exists',
      );
    });
  });

  describe('fieldExists', () => {
    it('should return true when field exists', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: {
          code: 0,
          msg: 'success',
          data: {
            items: [{ field_id: 'fld_001', field_name: '候选人', type: 1 }],
          },
        },
      });

      const result = await service.fieldExists('appToken', 'tableId', '候选人');
      expect(result).toBe(true);
    });

    it('should return false when field does not exist', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: {
          code: 0,
          msg: 'success',
          data: {
            items: [{ field_id: 'fld_001', field_name: '候选人', type: 1 }],
          },
        },
      });

      const result = await service.fieldExists('appToken', 'tableId', '不存在字段');
      expect(result).toBe(false);
    });
  });

  describe('buildFieldNameToIdMap', () => {
    it('should build a map from field names to field IDs', () => {
      const fields = [
        { field_id: 'fld_001', field_name: '候选人', type: 1 },
        { field_id: 'fld_002', field_name: '招募经理', type: 1 },
      ];

      const result = service.buildFieldNameToIdMap(fields);
      expect(result).toEqual({
        候选人: 'fld_001',
        招募经理: 'fld_002',
      });
    });

    it('should return empty map for empty array', () => {
      const result = service.buildFieldNameToIdMap([]);
      expect(result).toEqual({});
    });
  });

  describe('getRecord', () => {
    it('should return a single record', async () => {
      const record = { record_id: 'rec_001', fields: { 候选人: '张三' } };
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 0, msg: 'success', data: { record } },
      });

      const result = await service.getRecord('appToken', 'tableId', 'rec_001');
      expect(result).toEqual(record);
    });

    it('should throw error on API failure', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 1254040, msg: 'record not found' },
      });

      await expect(service.getRecord('appToken', 'tableId', 'rec_bad')).rejects.toThrow(
        '获取记录失败: record not found',
      );
    });
  });

  describe('getAllRecords', () => {
    it('should return all records in a single page', async () => {
      const items = [
        { record_id: 'rec_001', fields: { 候选人: '张三' } },
        { record_id: 'rec_002', fields: { 候选人: '李四' } },
      ];
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 0, msg: 'success', data: { items } },
      });

      const result = await service.getAllRecords('appToken', 'tableId');
      expect(result).toHaveLength(2);
      expect(result).toEqual(items);
    });

    it('should handle pagination correctly', async () => {
      const firstPage = [{ record_id: 'rec_001', fields: {} }];
      const secondPage = [{ record_id: 'rec_002', fields: {} }];

      mockFeishuApi.get
        .mockResolvedValueOnce({
          data: {
            code: 0,
            msg: 'success',
            data: { items: firstPage, page_token: 'token_page2' },
          },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            msg: 'success',
            data: { items: secondPage },
          },
        });

      const result = await service.getAllRecords('appToken', 'tableId');
      expect(result).toHaveLength(2);
      expect(mockFeishuApi.get).toHaveBeenCalledTimes(2);
    });

    it('should throw error on API failure', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 1254040, msg: 'table not found' },
      });

      await expect(service.getAllRecords('appToken', 'tableId')).rejects.toThrow(
        '获取表格记录失败: table not found',
      );
    });
  });

  describe('queryRecords', () => {
    it('should query records without filter', async () => {
      const items = [{ record_id: 'rec_001', fields: {} }];
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 0, msg: 'success', data: { items } },
      });

      const result = await service.queryRecords('appToken', 'tableId');
      expect(result).toEqual(items);
    });

    it('should pass filter to API when provided', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 0, msg: 'success', data: { items: [] } },
      });

      await service.queryRecords('appToken', 'tableId', 'CurrentValue.[候选人] = "张三"');
      const call = mockFeishuApi.get.mock.calls[0];
      expect(call[1]).toMatchObject({ params: { filter: 'CurrentValue.[候选人] = "张三"' } });
    });

    it('should throw error on API failure', async () => {
      mockFeishuApi.get.mockResolvedValue({
        data: { code: 1254040, msg: 'query failed' },
      });

      await expect(service.queryRecords('appToken', 'tableId')).rejects.toThrow(
        '查询记录失败: query failed',
      );
    });
  });

  describe('createRecord', () => {
    it('should create a record and return its ID', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: {
          code: 0,
          msg: 'success',
          data: { record: { record_id: 'rec_new' } },
        },
      });

      const result = await service.createRecord('appToken', 'tableId', { 候选人: '王五' });
      expect(result.recordId).toBe('rec_new');
    });

    it('should throw error on API failure', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 1254040, msg: 'create record failed' },
      });

      await expect(service.createRecord('appToken', 'tableId', { 候选人: '王五' })).rejects.toThrow(
        '创建记录失败: create record failed',
      );
    });
  });

  describe('batchCreateRecords', () => {
    it('should batch create records and return counts', async () => {
      const records = [{ fields: { 候选人: '张三' } }, { fields: { 候选人: '李四' } }];
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 0, msg: 'success' },
      });

      const result = await service.batchCreateRecords('appToken', 'tableId', records);
      expect(result.created).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should count failures when API returns non-zero code', async () => {
      const records = [{ fields: { 候选人: '张三' } }];
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 1254040, msg: 'batch create failed' },
      });

      const result = await service.batchCreateRecords('appToken', 'tableId', records);
      expect(result.created).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('should count failures when API throws exception', async () => {
      const records = [{ fields: { 候选人: '张三' } }];
      mockFeishuApi.post.mockRejectedValue(new Error('Network error'));

      const result = await service.batchCreateRecords('appToken', 'tableId', records);
      expect(result.created).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('should process records in batches of batchSize', async () => {
      const records = Array.from({ length: 5 }, (_, i) => ({ fields: { id: i } }));
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 0, msg: 'success' },
      });

      await service.batchCreateRecords('appToken', 'tableId', records, 2);
      // 5 records with batch size 2: 3 batches (2, 2, 1)
      expect(mockFeishuApi.post).toHaveBeenCalledTimes(3);
    });
  });

  describe('updateRecord', () => {
    it('should update a record successfully', async () => {
      mockFeishuApi.put.mockResolvedValue({
        data: { code: 0, msg: 'success' },
      });

      const result = await service.updateRecord('appToken', 'tableId', 'rec_001', {
        候选人: '新姓名',
      });
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return failure when API returns non-zero code', async () => {
      mockFeishuApi.put.mockResolvedValue({
        data: { code: 1254040, msg: 'record not found' },
      });

      const result = await service.updateRecord('appToken', 'tableId', 'rec_bad', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('record not found');
    });

    it('should return failure when exception is thrown', async () => {
      mockFeishuApi.put.mockRejectedValue(new Error('Network error'));

      const result = await service.updateRecord('appToken', 'tableId', 'rec_001', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('batchUpdateRecords', () => {
    it('should batch update records and return counts', async () => {
      const records = [
        { record_id: 'rec_001', fields: { 候选人: '新张三' } },
        { record_id: 'rec_002', fields: { 候选人: '新李四' } },
      ];
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 0, msg: 'success' },
      });

      const result = await service.batchUpdateRecords('appToken', 'tableId', records);
      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should count failures when batch update fails', async () => {
      const records = [{ record_id: 'rec_001', fields: {} }];
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 1254040, msg: 'update failed' },
      });

      const result = await service.batchUpdateRecords('appToken', 'tableId', records);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('should count failures when exception is thrown', async () => {
      const records = [{ record_id: 'rec_001', fields: {} }];
      mockFeishuApi.post.mockRejectedValue(new Error('Network error'));

      const result = await service.batchUpdateRecords('appToken', 'tableId', records);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
    });
  });

  describe('deleteRecord', () => {
    it('should delete a record successfully', async () => {
      mockFeishuApi.delete.mockResolvedValue({
        data: { code: 0, msg: 'success' },
      });

      const result = await service.deleteRecord('appToken', 'tableId', 'rec_001');
      expect(result.success).toBe(true);
    });

    it('should return failure when API returns non-zero code', async () => {
      mockFeishuApi.delete.mockResolvedValue({
        data: { code: 1254040, msg: 'record not found' },
      });

      const result = await service.deleteRecord('appToken', 'tableId', 'rec_bad');
      expect(result.success).toBe(false);
      expect(result.error).toBe('record not found');
    });

    it('should return failure when exception is thrown', async () => {
      mockFeishuApi.delete.mockRejectedValue(new Error('Network error'));

      const result = await service.deleteRecord('appToken', 'tableId', 'rec_001');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });
  });

  describe('batchDeleteRecords', () => {
    it('should batch delete records and return counts', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 0, msg: 'success' },
      });

      const result = await service.batchDeleteRecords('appToken', 'tableId', [
        'rec_001',
        'rec_002',
      ]);
      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should count failures when batch delete fails', async () => {
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 1254040, msg: 'delete failed' },
      });

      const result = await service.batchDeleteRecords('appToken', 'tableId', ['rec_001']);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('should count failures when exception is thrown', async () => {
      mockFeishuApi.post.mockRejectedValue(new Error('Network error'));

      const result = await service.batchDeleteRecords('appToken', 'tableId', ['rec_001']);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('should process deletions in batches of 500', async () => {
      // Generate 600 record IDs
      const recordIds = Array.from({ length: 600 }, (_, i) => `rec_${i}`);
      mockFeishuApi.post.mockResolvedValue({
        data: { code: 0, msg: 'success' },
      });

      await service.batchDeleteRecords('appToken', 'tableId', recordIds);
      // 600 records with batch size 500: 2 batches
      expect(mockFeishuApi.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('truncateText', () => {
    it('should return text unchanged when within limit', () => {
      const text = 'Short text';
      const result = service.truncateText(text, 2000);
      expect(result).toBe(text);
    });

    it('should truncate text and append indicator when exceeding limit', () => {
      const longText = 'a'.repeat(2001);
      const result = service.truncateText(longText, 2000);
      expect(result).toBe('a'.repeat(2000) + '...(truncated)');
    });

    it('should use default maxLength of 2000', () => {
      const text = 'b'.repeat(2001);
      const result = service.truncateText(text);
      // Result is 2000 chars + '...(truncated)' suffix
      expect(result).toMatch(/\.\.\.\(truncated\)$/);
      expect(result.startsWith('b'.repeat(2000))).toBe(true);
    });

    it('should return empty string for empty input', () => {
      const result = service.truncateText('');
      expect(result).toBe('');
    });

    it('should return empty string for null-like falsy input', () => {
      const result = service.truncateText(null as unknown as string);
      expect(result).toBe('');
    });

    it('should handle text exactly at limit', () => {
      const text = 'c'.repeat(2000);
      const result = service.truncateText(text, 2000);
      expect(result).toBe(text);
    });
  });
});
