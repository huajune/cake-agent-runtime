import { Test, TestingModule } from '@nestjs/testing';
import { GroupController } from '@wecom/group/group.controller';
import { GroupService } from '@wecom/group/group.service';

describe('GroupController', () => {
  let controller: GroupController;
  let service: GroupService;

  const mockGroupService = {
    getGroupList: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupController],
      providers: [
        {
          provide: GroupService,
          useValue: mockGroupService,
        },
      ],
    }).compile();

    controller = module.get<GroupController>(GroupController);
    service = module.get<GroupService>(GroupService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getGroupList', () => {
    it('should call groupService.getGroupList with token only when no pagination provided', async () => {
      const token = 'enterprise-token';
      const mockResult = { data: [{ groupId: 'g-1', name: 'Group 1' }], total: 1 };

      mockGroupService.getGroupList.mockResolvedValue(mockResult);

      const result = await controller.getGroupList(token);

      expect(service.getGroupList).toHaveBeenCalledWith({
        token,
        current: undefined,
        pageSize: undefined,
      });
      expect(result).toEqual(mockResult);
    });

    it('should parse current string to integer', async () => {
      const token = 'enterprise-token';
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList(token, '2');

      expect(service.getGroupList).toHaveBeenCalledWith({
        token,
        current: 2,
        pageSize: undefined,
      });
    });

    it('should parse pageSize string to integer', async () => {
      const token = 'enterprise-token';
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList(token, undefined, '50');

      expect(service.getGroupList).toHaveBeenCalledWith({
        token,
        current: undefined,
        pageSize: 50,
      });
    });

    it('should parse both current and pageSize strings to integers', async () => {
      const token = 'enterprise-token';
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList(token, '3', '100');

      expect(service.getGroupList).toHaveBeenCalledWith({
        token,
        current: 3,
        pageSize: 100,
      });
    });

    it('should use undefined for current when empty string is passed', async () => {
      const token = 'enterprise-token';
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList(token, undefined, undefined);

      expect(service.getGroupList).toHaveBeenCalledWith({
        token,
        current: undefined,
        pageSize: undefined,
      });
    });

    it('should return the result from groupService', async () => {
      const token = 'enterprise-token';
      const expectedResult = {
        data: [
          { groupId: 'g-1', name: 'Group Alpha' },
          { groupId: 'g-2', name: 'Group Beta' },
        ],
        total: 2,
      };

      mockGroupService.getGroupList.mockResolvedValue(expectedResult);

      const result = await controller.getGroupList(token, '1', '20');

      expect(result).toEqual(expectedResult);
    });

    it('should propagate errors from groupService', async () => {
      const token = 'enterprise-token';
      mockGroupService.getGroupList.mockRejectedValue(new Error('Service error'));

      await expect(controller.getGroupList(token)).rejects.toThrow('Service error');
    });
  });
});
