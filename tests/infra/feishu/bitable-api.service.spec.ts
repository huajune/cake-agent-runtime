import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import { FeishuApiService } from '@infra/feishu/services/api.service';

describe('FeishuBitableApiService', () => {
  let service: FeishuBitableApiService;

  const mockFeishuApiService = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config: Record<string, string> = {
        FEISHU_BITABLE_TEST_SUITE_APP_TOKEN: '  app_test_suite  ',
        FEISHU_BITABLE_TEST_SUITE_TABLE_ID: ' tbl_test_suite ',
      };
      return config[key];
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeishuBitableApiService,
        { provide: FeishuApiService, useValue: mockFeishuApiService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<FeishuBitableApiService>(FeishuBitableApiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTableConfig', () => {
    it('loads app token and table id from environment variables', () => {
      const result = service.getTableConfig('testSuite');

      expect(result).toEqual({
        appToken: 'app_test_suite',
        tableId: 'tbl_test_suite',
      });
      expect(mockConfigService.get).toHaveBeenCalledWith('FEISHU_BITABLE_TEST_SUITE_APP_TOKEN');
      expect(mockConfigService.get).toHaveBeenCalledWith('FEISHU_BITABLE_TEST_SUITE_TABLE_ID');
    });

    it('returns cached config on repeated reads', () => {
      const first = service.getTableConfig('testSuite');
      const second = service.getTableConfig('testSuite');

      expect(first).toBe(second);
      expect(mockConfigService.get).toHaveBeenCalledTimes(2);
    });

    it('falls back to empty strings when env vars are missing', () => {
      mockConfigService.get.mockImplementation(() => undefined);

      const result = service.getTableConfig('badcase');

      expect(result).toEqual({
        appToken: '',
        tableId: '',
      });
      expect(mockConfigService.get).toHaveBeenCalledWith('FEISHU_BITABLE_BADCASE_APP_TOKEN');
      expect(mockConfigService.get).toHaveBeenCalledWith('FEISHU_BITABLE_BADCASE_TABLE_ID');
    });
  });
});
