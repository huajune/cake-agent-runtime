import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
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

  const mockConfigService = {
    get: jest.fn().mockReturnValue('enterprise-token'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<GroupService>(GroupService);
    jest.clearAllMocks();
    mockConfigService.get.mockReturnValue('enterprise-token');
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getGroupList', () => {
    it('should return group list with default params', async () => {
      const mockResult = {
        data: [
          { groupId: 'g-1', name: 'Group 1' },
          { groupId: 'g-2', name: 'Group 2' },
        ],
        total: 2,
      };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getGroupList({});

      expect(mockApiConfig.endpoints.group.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith(
        'https://api.example.com/group/list',
        { token: 'enterprise-token' },
      );
      expect(result).toEqual(mockResult);
    });

    it('should include current page number when provided', async () => {
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getGroupList({ current: 2 });

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token: 'enterprise-token',
        current: 2,
      });
    });

    it('should include pageSize when provided', async () => {
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getGroupList({ pageSize: 50 });

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token: 'enterprise-token',
        pageSize: 50,
      });
    });

    it('should pass all params including pagination', async () => {
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getGroupList({ current: 1, pageSize: 20 });

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token: 'enterprise-token',
        current: 1,
        pageSize: 20,
      });
    });

    it('should return empty data when no groups exist', async () => {
      const emptyResult = { data: [], total: 0 };

      mockHttpService.get.mockResolvedValue(emptyResult);

      const result = await service.getGroupList({});

      expect(result).toEqual(emptyResult);
    });

    it('should throw error when STRIDE_ENTERPRISE_TOKEN is not configured', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      await expect(service.getGroupList({})).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw error when API call fails', async () => {
      const error = new Error('Forbidden');

      mockHttpService.get.mockRejectedValue(error);

      await expect(service.getGroupList({})).rejects.toThrow('Forbidden');
    });

    it('should re-throw the original error', async () => {
      const originalError = new Error('Server error');

      mockHttpService.get.mockRejectedValue(originalError);

      await expect(service.getGroupList({})).rejects.toBe(originalError);
    });
  });
});
