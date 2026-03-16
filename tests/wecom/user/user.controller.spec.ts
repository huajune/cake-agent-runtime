import { Test, TestingModule } from '@nestjs/testing';
import { UserController } from '@wecom/user/user.controller';
import { UserService } from '@wecom/user/user.service';

describe('UserController', () => {
  let controller: UserController;
  let service: UserService;

  const mockUserService = {
    getUserList: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        {
          provide: UserService,
          useValue: mockUserService,
        },
      ],
    }).compile();

    controller = module.get<UserController>(UserController);
    service = module.get<UserService>(UserService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getUserList', () => {
    it('should call userService.getUserList with all parameters', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 20;
      const mockResult = {
        data: [
          { userId: 'user1', name: 'John Doe' },
          { userId: 'user2', name: 'Jane Smith' },
        ],
        total: 2,
      };

      mockUserService.getUserList.mockResolvedValue(mockResult);

      const result = await controller.getUserList(token, current, pageSize);

      expect(service.getUserList).toHaveBeenCalledWith(token, current, pageSize);
      expect(result).toEqual(mockResult);
    });

    it('should call userService.getUserList with only required token', async () => {
      const token = 'test-token';
      const mockResult = { data: [], total: 0 };

      mockUserService.getUserList.mockResolvedValue(mockResult);

      const result = await controller.getUserList(token);

      expect(service.getUserList).toHaveBeenCalledWith(token, undefined, undefined);
      expect(result).toEqual(mockResult);
    });

    it('should handle pagination correctly', async () => {
      const token = 'test-token';
      const current = 2;
      const pageSize = 10;
      const mockResult = {
        data: [
          { userId: 'user21', name: 'User 21' },
          { userId: 'user22', name: 'User 22' },
        ],
        total: 50,
      };

      mockUserService.getUserList.mockResolvedValue(mockResult);

      const result = await controller.getUserList(token, current, pageSize);

      expect(service.getUserList).toHaveBeenCalledWith(token, current, pageSize);
      expect(result).toEqual(mockResult);
    });

    it('should handle empty user list', async () => {
      const token = 'test-token';
      const mockResult = { data: [], total: 0 };

      mockUserService.getUserList.mockResolvedValue(mockResult);

      const result = await controller.getUserList(token);

      expect(service.getUserList).toHaveBeenCalledWith(token, undefined, undefined);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from userService.getUserList', async () => {
      const token = 'test-token';
      const error = new Error('Service error');

      mockUserService.getUserList.mockRejectedValue(error);

      await expect(controller.getUserList(token)).rejects.toThrow('Service error');
    });

    it('should handle large page size', async () => {
      const token = 'test-token';
      const current = 0;
      const pageSize = 100;
      const mockResult = { data: [], total: 0 };

      mockUserService.getUserList.mockResolvedValue(mockResult);

      const result = await controller.getUserList(token, current, pageSize);

      expect(service.getUserList).toHaveBeenCalledWith(token, current, pageSize);
      expect(result).toEqual(mockResult);
    });
  });
});
