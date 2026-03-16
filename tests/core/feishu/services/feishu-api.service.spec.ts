import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FeishuApiService } from '@core/feishu/services/feishu-api.service';

// Mock axios
const mockAxiosInstance = {
  post: jest.fn(),
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockAxiosInstance),
  default: {
    create: jest.fn(() => mockAxiosInstance),
  },
}));

describe('FeishuApiService', () => {
  let service: FeishuApiService;

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        FEISHU_APP_ID: 'env-app-id',
        FEISHU_APP_SECRET: 'env-app-secret',
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeishuApiService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get<FeishuApiService>(FeishuApiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getAppId / getAppSecret ====================

  describe('getAppId and getAppSecret', () => {
    it('should return appId from code config (feishuBitableConfig) when available', () => {
      // feishuBitableConfig has a real appId: 'cli_a9ae9bcd92f99cc0'
      const appId = service.getAppId();
      expect(appId).toBeTruthy();
      expect(typeof appId).toBe('string');
    });

    it('should return appSecret from code config when available', () => {
      const appSecret = service.getAppSecret();
      expect(appSecret).toBeTruthy();
      expect(typeof appSecret).toBe('string');
    });
  });

  // ==================== getToken ====================

  describe('getToken', () => {
    it('should request new token when no cache exists', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          code: 0,
          tenant_access_token: 'test-token-123',
          expire: 7200,
        },
      });

      const token = await service.getToken();

      expect(token).toBe('test-token-123');
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/auth/v3/tenant_access_token/internal',
        expect.objectContaining({
          app_id: expect.any(String),
          app_secret: expect.any(String),
        }),
      );
    });

    it('should return cached token when cache is valid', async () => {
      // First call populates cache
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          code: 0,
          tenant_access_token: 'cached-token',
          expire: 7200,
        },
      });
      await service.getToken();

      jest.clearAllMocks();

      // Second call should use cache
      const token = await service.getToken();

      expect(token).toBe('cached-token');
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should refresh token when cache is about to expire', async () => {
      // Set cache with expiry 4 minutes from now (less than 5-minute buffer)
      (service as any).tokenCache = {
        token: 'expiring-token',
        expireAt: Date.now() + 4 * 60 * 1000,
      };

      mockAxiosInstance.post.mockResolvedValue({
        data: {
          code: 0,
          tenant_access_token: 'new-token',
          expire: 7200,
        },
      });

      const token = await service.getToken();

      expect(token).toBe('new-token');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
    });

    it('should use default expire of 7200 when not in response', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          code: 0,
          tenant_access_token: 'test-token',
          // no expire field
        },
      });

      const beforeCall = Date.now();
      await service.getToken();
      const afterCall = Date.now();

      const tokenCache = (service as any).tokenCache;
      // Should use default 7200 seconds
      expect(tokenCache.expireAt).toBeGreaterThanOrEqual(beforeCall + 7200 * 1000);
      expect(tokenCache.expireAt).toBeLessThanOrEqual(afterCall + 7200 * 1000 + 100);
    });

    it('should throw error when API returns non-zero code', async () => {
      mockAxiosInstance.post.mockResolvedValue({
        data: {
          code: 10002,
          msg: 'app not found',
        },
      });

      await expect(service.getToken()).rejects.toThrow('获取飞书 Token 失败');
    });
  });

  // ==================== clearTokenCache ====================

  describe('clearTokenCache', () => {
    it('should clear the token cache', async () => {
      // First populate cache
      mockAxiosInstance.post.mockResolvedValue({
        data: { code: 0, tenant_access_token: 'some-token', expire: 7200 },
      });
      await service.getToken();

      expect((service as any).tokenCache).toBeDefined();

      service.clearTokenCache();

      expect((service as any).tokenCache).toBeUndefined();
    });
  });

  // ==================== get ====================

  describe('get', () => {
    beforeEach(() => {
      // Pre-populate token cache to avoid token fetch
      (service as any).tokenCache = {
        token: 'valid-token',
        expireAt: Date.now() + 3600 * 1000,
      };
    });

    it('should make GET request with Authorization header', async () => {
      const mockResponse = { data: { code: 0, data: { items: [] } } };
      mockAxiosInstance.get.mockResolvedValue(mockResponse);

      const result = await service.get('/documents/list');

      expect(result).toEqual(mockResponse);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/documents/list',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
          }),
        }),
      );
    });

    it('should merge custom config headers with auth header', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: {} });

      await service.get('/test', { headers: { 'X-Custom': 'value' } });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        '/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
            'X-Custom': 'value',
          }),
        }),
      );
    });
  });

  // ==================== post ====================

  describe('post', () => {
    beforeEach(() => {
      (service as any).tokenCache = {
        token: 'valid-token',
        expireAt: Date.now() + 3600 * 1000,
      };
    });

    it('should make POST request with Authorization header', async () => {
      const requestData = { field: 'value' };
      const mockResponse = { data: { code: 0 } };
      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await service.post('/records/create', requestData);

      expect(result).toEqual(mockResponse);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/records/create',
        requestData,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
          }),
        }),
      );
    });

    it('should handle POST without body', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: {} });

      await service.post('/test/endpoint');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/test/endpoint',
        undefined,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }),
        }),
      );
    });
  });

  // ==================== put ====================

  describe('put', () => {
    beforeEach(() => {
      (service as any).tokenCache = {
        token: 'valid-token',
        expireAt: Date.now() + 3600 * 1000,
      };
    });

    it('should make PUT request with Authorization header', async () => {
      const updateData = { field: 'updated' };
      mockAxiosInstance.put.mockResolvedValue({ data: { code: 0 } });

      await service.put('/records/123', updateData);

      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        '/records/123',
        updateData,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
          }),
        }),
      );
    });
  });

  // ==================== delete ====================

  describe('delete', () => {
    beforeEach(() => {
      (service as any).tokenCache = {
        token: 'valid-token',
        expireAt: Date.now() + 3600 * 1000,
      };
    });

    it('should make DELETE request with Authorization header', async () => {
      mockAxiosInstance.delete.mockResolvedValue({ data: { code: 0 } });

      await service.delete('/records/123');

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
        '/records/123',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
          }),
        }),
      );
    });
  });
});
