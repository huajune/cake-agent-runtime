import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SpongeBiService } from '@sponge/sponge-bi.service';

describe('SpongeBiService', () => {
  let service: SpongeBiService;
  let configService: ConfigService;
  let originalFetch: typeof global.fetch;

  const configMap: Record<string, string> = {
    GUANYUAN_LOGIN_ID: 'test-login',
    GUANYUAN_PASSWORD: 'test-pass',
    GUANYUAN_REFRESH_TOKEN: 'refresh-token',
    GUANYUAN_BI_BASE_URL: 'https://bi.test.com',
    GUANYUAN_BI_CARD_ID: 'test-card',
    GUANYUAN_BI_REFRESH_SOURCE_ID: 'test-source',
  };

  const mockConfigGet = jest.fn(
    (key: string, defaultValue?: string): string => configMap[key] ?? defaultValue ?? '',
  );

  const makeSignInResponse = () => ({
    ok: true,
    json: jest.fn().mockResolvedValue({
      result: 'ok',
      response: { token: 'bi-token' },
    }),
  });

  const makeCardDataResponse = (hasMoreData = false) => ({
    ok: true,
    json: jest.fn().mockResolvedValue({
      result: 'ok',
      response: {
        chartMain: {
          column: {
            values: [[{ title: '城市' }], [{ title: '门店' }]],
          },
          data: [[{ v: '上海' }, { v: '门店A' }]],
          hasMoreData,
        },
      },
    }),
  });

  const makeRefreshResponse = () => ({
    ok: true,
    json: jest.fn().mockResolvedValue({
      result: 'ok',
      response: { taskId: '123' },
    }),
  });

  beforeEach(async () => {
    originalFetch = global.fetch;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpongeBiService,
        {
          provide: ConfigService,
          useValue: { get: mockConfigGet } as unknown as ConfigService,
        },
      ],
    }).compile();

    service = module.get<SpongeBiService>(SpongeBiService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    mockConfigGet.mockReset();
    mockConfigGet.mockImplementation(
      (key: string, defaultValue?: string): string => configMap[key] ?? defaultValue ?? '',
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('fetchBIOrders', () => {
    it('should return empty array when GUANYUAN_LOGIN_ID is missing', async () => {
      mockConfigGet.mockImplementation((key: string, defaultValue?: string): string => {
        if (key === 'GUANYUAN_LOGIN_ID') return '';
        return configMap[key] ?? defaultValue ?? '';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SpongeBiService,
          {
            provide: ConfigService,
            useValue: { get: mockConfigGet } as unknown as ConfigService,
          },
        ],
      }).compile();

      const svc = module.get<SpongeBiService>(SpongeBiService);
      const result = await svc.fetchBIOrders({});

      expect(result).toEqual([]);
    });

    it('should call sign-in then card data API and return parsed orders', async () => {
      const mockFetch = jest.fn();

      // First call: sign-in
      mockFetch.mockResolvedValueOnce(makeSignInResponse() as unknown as Response);
      // Second call: card data
      mockFetch.mockResolvedValueOnce(makeCardDataResponse() as unknown as Response);

      global.fetch = mockFetch;

      const result = await service.fetchBIOrders({});

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify sign-in call
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://bi.test.com/sign-in',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('test-login'),
        }),
      );

      // Verify card data call
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://bi.test.com/card/test-card/data',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'X-Auth-Token': 'bi-token' }),
        }),
      );

      expect(result).toEqual([{ '城市': '上海', '门店': '门店A' }]);
    });

    it('should use cached token on second call (sign-in called only once)', async () => {
      const mockFetch = jest.fn();

      // First fetchBIOrders: sign-in + card data
      mockFetch.mockResolvedValueOnce(makeSignInResponse() as unknown as Response);
      mockFetch.mockResolvedValueOnce(makeCardDataResponse() as unknown as Response);
      // Second fetchBIOrders: only card data (token cached)
      mockFetch.mockResolvedValueOnce(makeCardDataResponse() as unknown as Response);

      global.fetch = mockFetch;

      await service.fetchBIOrders({});
      await service.fetchBIOrders({});

      // sign-in should only be called once; card data twice = 3 total
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const signInCalls = mockFetch.mock.calls.filter(
        ([url]: [string]) => url === 'https://bi.test.com/sign-in',
      );
      expect(signInCalls).toHaveLength(1);
    });

    it('should handle API error gracefully and throw Error', async () => {
      const mockFetch = jest.fn();

      // sign-in succeeds
      mockFetch.mockResolvedValueOnce(makeSignInResponse() as unknown as Response);
      // card data fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as unknown as Response);

      global.fetch = mockFetch;

      await expect(service.fetchBIOrders({})).rejects.toThrow(Error);
    });
  });

  describe('refreshBIDataSource', () => {
    it('should return true on success', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce(
        makeRefreshResponse() as unknown as Response,
      );
      global.fetch = mockFetch;

      const result = await service.refreshBIDataSource();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('data-source/test-source/refresh?token=refresh-token'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return false when GUANYUAN_REFRESH_TOKEN is missing', async () => {
      mockConfigGet.mockImplementation((key: string, defaultValue?: string): string => {
        if (key === 'GUANYUAN_REFRESH_TOKEN') return '';
        return configMap[key] ?? defaultValue ?? '';
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SpongeBiService,
          {
            provide: ConfigService,
            useValue: { get: mockConfigGet } as unknown as ConfigService,
          },
        ],
      }).compile();

      const svc = module.get<SpongeBiService>(SpongeBiService);
      const result = await svc.refreshBIDataSource();

      expect(result).toBe(false);
    });

    it('should return false on API error', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as unknown as Response);
      global.fetch = mockFetch;

      const result = await service.refreshBIDataSource();

      expect(result).toBe(false);
    });
  });
});
