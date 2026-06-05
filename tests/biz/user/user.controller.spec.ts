import { Test, TestingModule } from '@nestjs/testing';
import { UserController } from '@biz/user/user.controller';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

describe('UserController (biz/user)', () => {
  let controller: UserController;
  let userHostingService: UserHostingService;

  const mockUserHostingService = {
    pauseUser: jest.fn(),
    resumeUser: jest.fn(),
    getPausedUsersWithProfiles: jest.fn(),
    isUserPaused: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        {
          provide: UserHostingService,
          useValue: mockUserHostingService,
        },
      ],
    }).compile();

    controller = module.get<UserController>(UserController);
    userHostingService = module.get<UserHostingService>(UserHostingService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('pauseUserHosting', () => {
    it('should pause user hosting and return success response', async () => {
      const userId = 'user-123';
      mockUserHostingService.pauseUser.mockResolvedValue(undefined);

      const result = await controller.pauseUserHosting(userId);

      expect(userHostingService.pauseUser).toHaveBeenCalledWith(userId);
      expect(result).toEqual({
        userId,
        isPaused: true,
        message: `用户 ${userId} 的托管已暂停`,
      });
    });

    it('should propagate errors from userHostingService.pauseUser', async () => {
      mockUserHostingService.pauseUser.mockRejectedValue(new Error('User not found'));

      await expect(controller.pauseUserHosting('user-not-found')).rejects.toThrow('User not found');
    });

    it('should include userId in the response', async () => {
      const userId = 'special-user-id';
      mockUserHostingService.pauseUser.mockResolvedValue(undefined);

      const result = await controller.pauseUserHosting(userId);

      expect(result.userId).toBe(userId);
    });
  });

  describe('resumeUserHosting', () => {
    it('should resume user hosting and return success response', async () => {
      const userId = 'user-456';
      mockUserHostingService.resumeUser.mockResolvedValue(undefined);

      const result = await controller.resumeUserHosting(userId);

      expect(userHostingService.resumeUser).toHaveBeenCalledWith(userId);
      expect(result).toEqual({
        userId,
        isPaused: false,
        message: `用户 ${userId} 的托管已恢复`,
      });
    });

    it('should propagate errors from userHostingService.resumeUser', async () => {
      mockUserHostingService.resumeUser.mockRejectedValue(new Error('DB error'));

      await expect(controller.resumeUserHosting('user-error')).rejects.toThrow('DB error');
    });

    it('should set isPaused to false in response', async () => {
      const userId = 'user-789';
      mockUserHostingService.resumeUser.mockResolvedValue(undefined);

      const result = await controller.resumeUserHosting(userId);

      expect(result.isPaused).toBe(false);
    });
  });

  describe('getPausedUsers', () => {
    it('should return list of paused users with profiles', async () => {
      const mockPausedUsers = [
        { userId: 'user-1', name: 'User One', isPaused: true },
        { userId: 'user-2', name: 'User Two', isPaused: true },
      ];
      mockUserHostingService.getPausedUsersWithProfiles.mockResolvedValue(mockPausedUsers);

      const result = await controller.getPausedUsers();

      expect(userHostingService.getPausedUsersWithProfiles).toHaveBeenCalled();
      expect(result).toEqual({ users: mockPausedUsers });
    });

    it('should return empty users array when no users are paused', async () => {
      mockUserHostingService.getPausedUsersWithProfiles.mockResolvedValue([]);

      const result = await controller.getPausedUsers();

      expect(result).toEqual({ users: [] });
    });

    it('should propagate errors from userHostingService', async () => {
      mockUserHostingService.getPausedUsersWithProfiles.mockRejectedValue(new Error('Cache error'));

      await expect(controller.getPausedUsers()).rejects.toThrow('Cache error');
    });
  });

  describe('getUserHostingStatus', () => {
    it('should return paused status for a given userId', async () => {
      const userId = 'user-status-check';
      mockUserHostingService.isUserPaused.mockResolvedValue(true);

      const result = await controller.getUserHostingStatus(userId);

      expect(userHostingService.isUserPaused).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ userId, isPaused: true });
    });

    it('should return false when user is not paused', async () => {
      const userId = 'user-active';
      mockUserHostingService.isUserPaused.mockResolvedValue(false);

      const result = await controller.getUserHostingStatus(userId);

      expect(result).toEqual({ userId, isPaused: false });
    });

    it('should propagate errors from userHostingService', async () => {
      mockUserHostingService.isUserPaused.mockRejectedValue(new Error('Lookup failed'));

      await expect(controller.getUserHostingStatus('user-error')).rejects.toThrow('Lookup failed');
    });
  });

  describe('toggleUserHosting', () => {
    it('should resume user when enabled is true', async () => {
      const chatId = 'chat-toggle-on';
      mockUserHostingService.resumeUser.mockResolvedValue(undefined);

      const result = await controller.toggleUserHosting(chatId, true);

      expect(userHostingService.resumeUser).toHaveBeenCalledWith(chatId);
      expect(userHostingService.pauseUser).not.toHaveBeenCalled();
      expect(result).toEqual({
        chatId,
        hostingEnabled: true,
        message: `用户 ${chatId} 的托管已启用`,
      });
    });

    it('should pause user when enabled is false', async () => {
      const chatId = 'chat-toggle-off';
      mockUserHostingService.pauseUser.mockResolvedValue(undefined);

      const result = await controller.toggleUserHosting(chatId, false);

      expect(userHostingService.pauseUser).toHaveBeenCalledWith(chatId);
      expect(userHostingService.resumeUser).not.toHaveBeenCalled();
      expect(result).toEqual({
        chatId,
        hostingEnabled: false,
        message: `用户 ${chatId} 的托管已暂停`,
      });
    });

    it('should propagate errors when enabling fails', async () => {
      mockUserHostingService.resumeUser.mockRejectedValue(new Error('Resume failed'));

      await expect(controller.toggleUserHosting('chat-error', true)).rejects.toThrow(
        'Resume failed',
      );
    });

    it('should propagate errors when disabling fails', async () => {
      mockUserHostingService.pauseUser.mockRejectedValue(new Error('Pause failed'));

      await expect(controller.toggleUserHosting('chat-error', false)).rejects.toThrow(
        'Pause failed',
      );
    });
  });
});
