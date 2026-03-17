import { Test, TestingModule } from '@nestjs/testing';
import { WeworkUserService } from '@wecom/user/wework-user.service';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

describe('WeworkUserService', () => {
  let service: WeworkUserService;

  const mockHttpService = {
    get: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      user: {
        list: jest.fn().mockReturnValue('https://api.example.com/user/list'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeworkUserService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<WeworkUserService>(WeworkUserService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getUserList', () => {
    it('should return user list with only token', async () => {
      const token = 'group-token';
      const mockResult = {
        data: [
          { userId: 'u-1', name: 'User 1', wecomUserId: 'wecom-1' },
          { userId: 'u-2', name: 'User 2', wecomUserId: 'wecom-2' },
        ],
        total: 2,
      };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getUserList(token);

      expect(mockApiConfig.endpoints.user.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/user/list', {
        token,
      });
      expect(result).toEqual(mockResult);
    });

    it('should include current page number when provided', async () => {
      const token = 'group-token';
      const current = 2;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getUserList(token, current);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, current });
    });

    it('should include pageSize when provided', async () => {
      const token = 'group-token';
      const pageSize = 100;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getUserList(token, undefined, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, pageSize });
    });

    it('should include both current and pageSize when both provided', async () => {
      const token = 'group-token';
      const current = 3;
      const pageSize = 50;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getUserList(token, current, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        current,
        pageSize,
      });
    });

    it('should not add current to params when it is undefined', async () => {
      const token = 'group-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getUserList(token, undefined, undefined);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('current');
    });

    it('should not add pageSize to params when it is undefined', async () => {
      const token = 'group-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getUserList(token, undefined, undefined);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('pageSize');
    });

    it('should return empty data when no users exist', async () => {
      const token = 'group-token';
      const emptyResult = { data: [], total: 0 };

      mockHttpService.get.mockResolvedValue(emptyResult);

      const result = await service.getUserList(token);

      expect(result).toEqual(emptyResult);
    });

    it('should throw error when API call fails', async () => {
      const token = 'group-token';
      const error = new Error('Connection timeout');

      mockHttpService.get.mockRejectedValue(error);

      await expect(service.getUserList(token)).rejects.toThrow('Connection timeout');
    });

    it('should re-throw the original error', async () => {
      const token = 'group-token';
      const originalError = new Error('Server error 500');

      mockHttpService.get.mockRejectedValue(originalError);

      await expect(service.getUserList(token)).rejects.toBe(originalError);
    });

    it('should work with page 0 (zero-based pagination)', async () => {
      const token = 'group-token';
      const current = 0;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getUserList(token, current);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, current: 0 });
    });
  });
});
