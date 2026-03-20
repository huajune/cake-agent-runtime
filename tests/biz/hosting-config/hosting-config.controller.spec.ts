import { Test, TestingModule } from '@nestjs/testing';
import { HostingConfigController } from '@biz/hosting-config/hosting-config.controller';
import { HostingConfigFacadeService } from '@biz/hosting-config/services/hosting-config-facade.service';

describe('HostingConfigController', () => {
  let controller: HostingConfigController;
  let facade: HostingConfigFacadeService;

  const mockFacadeService = {
    getAgentReplyConfig: jest.fn(),
    updateAgentReplyConfig: jest.fn(),
    resetAgentReplyConfig: jest.fn(),
    getBlacklist: jest.fn(),
    addToBlacklist: jest.fn(),
    removeFromBlacklist: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HostingConfigController],
      providers: [
        { provide: HostingConfigFacadeService, useValue: mockFacadeService },
      ],
    }).compile();

    controller = module.get<HostingConfigController>(HostingConfigController);
    facade = module.get<HostingConfigFacadeService>(HostingConfigFacadeService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getAgentReplyConfig', () => {
    it('should return agent reply config from facade', async () => {
      const mockConfig = {
        config: { initialMergeWindowMs: 1000, maxMergedMessages: 3 },
        defaults: { initialMergeWindowMs: 1000, maxMergedMessages: 3 },
      };

      mockFacadeService.getAgentReplyConfig.mockResolvedValue(mockConfig);

      const result = await controller.getAgentReplyConfig();

      expect(facade.getAgentReplyConfig).toHaveBeenCalled();
      expect(result).toEqual(mockConfig);
    });

    it('should propagate errors from facade', async () => {
      mockFacadeService.getAgentReplyConfig.mockRejectedValue(new Error('DB error'));

      await expect(controller.getAgentReplyConfig()).rejects.toThrow('DB error');
    });
  });

  describe('updateAgentReplyConfig', () => {
    it('should update config via facade and return result', async () => {
      const body = { initialMergeWindowMs: 2000 };
      const mockResult = { success: true, config: body };

      mockFacadeService.updateAgentReplyConfig.mockResolvedValue(mockResult);

      const result = await controller.updateAgentReplyConfig(body);

      expect(facade.updateAgentReplyConfig).toHaveBeenCalledWith(body);
      expect(result).toEqual(mockResult);
    });

    it('should support empty body', async () => {
      const body = {};
      mockFacadeService.updateAgentReplyConfig.mockResolvedValue({ success: true });

      await controller.updateAgentReplyConfig(body);

      expect(facade.updateAgentReplyConfig).toHaveBeenCalledWith({});
    });
  });

  describe('resetAgentReplyConfig', () => {
    it('should reset config via facade', async () => {
      const mockResult = { success: true, message: 'Config reset' };

      mockFacadeService.resetAgentReplyConfig.mockResolvedValue(mockResult);

      const result = await controller.resetAgentReplyConfig();

      expect(facade.resetAgentReplyConfig).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });
  });

  describe('getBlacklist', () => {
    it('should return blacklist from facade', async () => {
      const mockBlacklist = {
        chatIds: ['chat-1', 'chat-2'],
        groupIds: ['group-1'],
      };

      mockFacadeService.getBlacklist.mockResolvedValue(mockBlacklist);

      const result = await controller.getBlacklist();

      expect(facade.getBlacklist).toHaveBeenCalled();
      expect(result).toEqual(mockBlacklist);
    });
  });

  describe('addToBlacklist', () => {
    it('should add chatId to blacklist', async () => {
      const body = { id: 'chat-123', type: 'chatId' as const, reason: 'Spam' };
      const mockResult = { success: true };

      mockFacadeService.addToBlacklist.mockResolvedValue(mockResult);

      const result = await controller.addToBlacklist(body);

      expect(facade.addToBlacklist).toHaveBeenCalledWith('chat-123', 'chatId', 'Spam');
      expect(result).toEqual(mockResult);
    });

    it('should add groupId to blacklist without reason', async () => {
      const body = { id: 'group-456', type: 'groupId' as const };
      mockFacadeService.addToBlacklist.mockResolvedValue({ success: true });

      await controller.addToBlacklist(body);

      expect(facade.addToBlacklist).toHaveBeenCalledWith('group-456', 'groupId', undefined);
    });
  });

  describe('removeFromBlacklist', () => {
    it('should remove chatId from blacklist', async () => {
      const body = { id: 'chat-123', type: 'chatId' as const };
      const mockResult = { success: true };

      mockFacadeService.removeFromBlacklist.mockResolvedValue(mockResult);

      const result = await controller.removeFromBlacklist(body);

      expect(facade.removeFromBlacklist).toHaveBeenCalledWith('chat-123', 'chatId');
      expect(result).toEqual(mockResult);
    });

    it('should remove groupId from blacklist', async () => {
      const body = { id: 'group-789', type: 'groupId' as const };
      mockFacadeService.removeFromBlacklist.mockResolvedValue({ success: true });

      await controller.removeFromBlacklist(body);

      expect(facade.removeFromBlacklist).toHaveBeenCalledWith('group-789', 'groupId');
    });
  });
});
