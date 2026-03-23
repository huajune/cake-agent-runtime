import { Test, TestingModule } from '@nestjs/testing';
import { GroupService } from '@wecom/group/group.service';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

describe('GroupService', () => {
  let service: GroupService;

  const mockHttpService = {
    get: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      group: {
        list: jest.fn().mockReturnValue('https://api.example.com/group/list'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<GroupService>(GroupService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getGroupList', () => {
    it('should return group list with token only', async () => {
      const params = { token: 'enterprise-token' };
      const mockResult = {
        data: [
          { groupId: 'g-1', name: 'Group 1' },
          { groupId: 'g-2', name: 'Group 2' },
        ],
        total: 2,
      };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getGroupList(params);

      expect(mockApiConfig.endpoints.group.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith(
        'https://api.example.com/group/list',
        params,
      );
      expect(result).toEqual(mockResult);
    });

    it('should include current page number when provided', async () => {
      const params = { token: 'enterprise-token', current: 2 };
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getGroupList(params);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), params);
    });

    it('should include pageSize when provided', async () => {
      const params = { token: 'enterprise-token', pageSize: 50 };
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getGroupList(params);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), params);
    });

    it('should pass all params including pagination', async () => {
      const params = { token: 'enterprise-token', current: 1, pageSize: 20 };
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getGroupList(params);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token: 'enterprise-token',
        current: 1,
        pageSize: 20,
      });
    });

    it('should return empty data when no groups exist', async () => {
      const params = { token: 'enterprise-token' };
      const emptyResult = { data: [], total: 0 };

      mockHttpService.get.mockResolvedValue(emptyResult);

      const result = await service.getGroupList(params);

      expect(result).toEqual(emptyResult);
    });

    it('should throw error when API call fails', async () => {
      const params = { token: 'enterprise-token' };
      const error = new Error('Forbidden');

      mockHttpService.get.mockRejectedValue(error);

      await expect(service.getGroupList(params)).rejects.toThrow('Forbidden');
    });

    it('should re-throw the original error', async () => {
      const params = { token: 'enterprise-token' };
      const originalError = new Error('Server error');

      mockHttpService.get.mockRejectedValue(originalError);

      await expect(service.getGroupList(params)).rejects.toBe(originalError);
    });
  });
});
