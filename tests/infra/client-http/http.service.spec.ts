import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@infra/client-http/http.service';
import { HttpClientFactory } from '@infra/client-http/http-client.factory';

describe('HttpService', () => {
  let service: HttpService;

  const mockAxiosInstance = {
    get: jest.fn(),
    post: jest.fn(),
  };

  const mockHttpClientFactory = {
    create: jest.fn().mockReturnValue(mockAxiosInstance),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: number) => {
      const config: Record<string, number> = {
        HTTP_CLIENT_TIMEOUT: 30000,
      };
      return config[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockHttpClientFactory.create.mockReturnValue(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: HttpClientFactory, useValue: mockHttpClientFactory },
      ],
    }).compile();

    service = module.get<HttpService>(HttpService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create HTTP client with factory on construction', () => {
    expect(mockHttpClientFactory.create).toHaveBeenCalledWith({
      timeout: 30000,
      logPrefix: '[HTTP Service]',
      verbose: false,
    });
  });

  it('should use default timeout when config returns undefined', async () => {
    const noTimeoutConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpService,
        { provide: ConfigService, useValue: noTimeoutConfigService },
        { provide: HttpClientFactory, useValue: mockHttpClientFactory },
      ],
    }).compile();

    module.get<HttpService>(HttpService);

    expect(mockHttpClientFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 30000 }),
    );
  });

  // ==================== get ====================

  describe('get', () => {
    it('should make GET request and return data', async () => {
      const mockData = { users: ['Alice', 'Bob'] };
      mockAxiosInstance.get.mockResolvedValue({ data: mockData });

      const result = await service.get('https://api.example.com/users');

      expect(result).toEqual(mockData);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('https://api.example.com/users', {
        params: undefined,
      });
    });

    it('should pass query params', async () => {
      mockAxiosInstance.get.mockResolvedValue({ data: {} });

      await service.get('https://api.example.com/users', { page: 1, limit: 10 });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('https://api.example.com/users', {
        params: { page: 1, limit: 10 },
      });
    });

    it('should propagate errors from axios', async () => {
      const axiosError = new Error('Network Error');
      mockAxiosInstance.get.mockRejectedValue(axiosError);

      await expect(service.get('https://api.example.com/fail')).rejects.toThrow('Network Error');
    });

    it('should return response data directly', async () => {
      const responseData = 'string response';
      mockAxiosInstance.get.mockResolvedValue({ data: responseData });

      const result = await service.get('https://api.example.com/text');

      expect(result).toBe(responseData);
    });
  });

  // ==================== post ====================

  describe('post', () => {
    it('should make POST request and return data', async () => {
      const requestData = { name: 'test', value: 42 };
      const responseData = { id: '123', ...requestData };
      mockAxiosInstance.post.mockResolvedValue({ data: responseData });

      const result = await service.post('https://api.example.com/create', requestData);

      expect(result).toEqual(responseData);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'https://api.example.com/create',
        requestData,
      );
    });

    it('should handle POST without body', async () => {
      mockAxiosInstance.post.mockResolvedValue({ data: { success: true } });

      const result = await service.post('https://api.example.com/trigger');

      expect(result).toEqual({ success: true });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'https://api.example.com/trigger',
        undefined,
      );
    });

    it('should propagate errors from axios', async () => {
      const axiosError = new Error('Request failed with status code 500');
      mockAxiosInstance.post.mockRejectedValue(axiosError);

      await expect(service.post('https://api.example.com/fail', {})).rejects.toThrow(
        'Request failed with status code 500',
      );
    });

    it('should handle POST with complex nested data', async () => {
      const complexData = {
        user: { id: '1', name: 'Alice' },
        metadata: { tags: ['a', 'b'], count: 2 },
      };
      mockAxiosInstance.post.mockResolvedValue({ data: { ok: true } });

      await service.post('https://api.example.com/complex', complexData);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        'https://api.example.com/complex',
        complexData,
      );
    });
  });
});
