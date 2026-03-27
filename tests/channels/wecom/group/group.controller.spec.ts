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
    it('should call groupService.getGroupList with no pagination when none provided', async () => {
      const mockResult = { data: [{ groupId: 'g-1', name: 'Group 1' }], total: 1 };

      mockGroupService.getGroupList.mockResolvedValue(mockResult);

      const result = await controller.getGroupList();

      expect(service.getGroupList).toHaveBeenCalledWith({
        current: undefined,
        pageSize: undefined,
      });
      expect(result).toEqual(mockResult);
    });

    it('should parse current string to integer', async () => {
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList('2');

      expect(service.getGroupList).toHaveBeenCalledWith({
        current: 2,
        pageSize: undefined,
      });
    });

    it('should parse pageSize string to integer', async () => {
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList(undefined, '50');

      expect(service.getGroupList).toHaveBeenCalledWith({
        current: undefined,
        pageSize: 50,
      });
    });

    it('should parse both current and pageSize strings to integers', async () => {
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList('3', '100');

      expect(service.getGroupList).toHaveBeenCalledWith({
        current: 3,
        pageSize: 100,
      });
    });

    it('should use undefined for current and pageSize when not provided', async () => {
      mockGroupService.getGroupList.mockResolvedValue({ data: [] });

      await controller.getGroupList(undefined, undefined);

      expect(service.getGroupList).toHaveBeenCalledWith({
        current: undefined,
        pageSize: undefined,
      });
    });

    it('should return the result from groupService', async () => {
      const expectedResult = {
        data: [
          { groupId: 'g-1', name: 'Group Alpha' },
          { groupId: 'g-2', name: 'Group Beta' },
        ],
        total: 2,
      };

      mockGroupService.getGroupList.mockResolvedValue(expectedResult);

      const result = await controller.getGroupList('1', '20');

      expect(result).toEqual(expectedResult);
    });

    it('should propagate errors from groupService', async () => {
      mockGroupService.getGroupList.mockRejectedValue(new Error('Service error'));

      await expect(controller.getGroupList()).rejects.toThrow('Service error');
    });
  });
});
