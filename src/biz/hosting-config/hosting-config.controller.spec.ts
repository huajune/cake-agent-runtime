import { Test, TestingModule } from '@nestjs/testing';
import { HostingConfigController } from './hosting-config.controller';
import { HostingConfigFacadeService } from './services/hosting-config-facade.service';
import { MessageService } from '@wecom/message/message.service';
import { MessageProcessor } from '@wecom/message/message.processor';

describe('HostingConfigController', () => {
  let controller: HostingConfigController;
  let facade: HostingConfigFacadeService;
  let messageService: MessageService;
  let messageProcessor: MessageProcessor;

  const mockFacadeService = {
    getAgentReplyConfig: jest.fn(),
    updateAgentReplyConfig: jest.fn(),
    resetAgentReplyConfig: jest.fn(),
    getBlacklist: jest.fn(),
    addToBlacklist: jest.fn(),
    removeFromBlacklist: jest.fn(),
  };

  const mockMessageService = {
    getAiReplyStatus: jest.fn(),
    toggleAiReply: jest.fn(),
    getMessageMergeStatus: jest.fn(),
    toggleMessageMerge: jest.fn(),
  };

  const mockMessageProcessor = {
    getWorkerStatus: jest.fn(),
    setConcurrency: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HostingConfigController],
      providers: [
        { provide: HostingConfigFacadeService, useValue: mockFacadeService },
        { provide: MessageService, useValue: mockMessageService },
        { provide: MessageProcessor, useValue: mockMessageProcessor },
      ],
    }).compile();

    controller = module.get<HostingConfigController>(HostingConfigController);
    facade = module.get<HostingConfigFacadeService>(HostingConfigFacadeService);
    messageService = module.get<MessageService>(MessageService);
    messageProcessor = module.get<MessageProcessor>(MessageProcessor);
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

  describe('getAiReplyStatus', () => {
    it('should return enabled true when AI reply is enabled', () => {
      mockMessageService.getAiReplyStatus.mockReturnValue(true);

      const result = controller.getAiReplyStatus();

      expect(messageService.getAiReplyStatus).toHaveBeenCalled();
      expect(result).toEqual({ enabled: true });
    });

    it('should return enabled false when AI reply is disabled', () => {
      mockMessageService.getAiReplyStatus.mockReturnValue(false);

      const result = controller.getAiReplyStatus();

      expect(result).toEqual({ enabled: false });
    });
  });

  describe('toggleAiReply', () => {
    it('should enable AI reply and return enabled status', async () => {
      mockMessageService.toggleAiReply.mockResolvedValue(true);

      const result = await controller.toggleAiReply(true);

      expect(messageService.toggleAiReply).toHaveBeenCalledWith(true);
      expect(result).toEqual({
        enabled: true,
        message: 'AI 自动回复功能已启用',
      });
    });

    it('should disable AI reply and return disabled status', async () => {
      mockMessageService.toggleAiReply.mockResolvedValue(false);

      const result = await controller.toggleAiReply(false);

      expect(messageService.toggleAiReply).toHaveBeenCalledWith(false);
      expect(result).toEqual({
        enabled: false,
        message: 'AI 自动回复功能已禁用',
      });
    });
  });

  describe('getMessageMergeStatus', () => {
    it('should return enabled true when message merge is enabled', () => {
      mockMessageService.getMessageMergeStatus.mockReturnValue(true);

      const result = controller.getMessageMergeStatus();

      expect(messageService.getMessageMergeStatus).toHaveBeenCalled();
      expect(result).toEqual({ enabled: true });
    });

    it('should return enabled false when message merge is disabled', () => {
      mockMessageService.getMessageMergeStatus.mockReturnValue(false);

      const result = controller.getMessageMergeStatus();

      expect(result).toEqual({ enabled: false });
    });
  });

  describe('toggleMessageMerge', () => {
    it('should enable message merge and return enabled status', async () => {
      mockMessageService.toggleMessageMerge.mockResolvedValue(true);

      const result = await controller.toggleMessageMerge(true);

      expect(messageService.toggleMessageMerge).toHaveBeenCalledWith(true);
      expect(result).toEqual({
        enabled: true,
        message: '消息聚合功能已启用',
      });
    });

    it('should disable message merge and return disabled status', async () => {
      mockMessageService.toggleMessageMerge.mockResolvedValue(false);

      const result = await controller.toggleMessageMerge(false);

      expect(result).toEqual({
        enabled: false,
        message: '消息聚合功能已禁用',
      });
    });
  });

  describe('getWorkerStatus', () => {
    it('should return combined worker status and message merge status', () => {
      const workerStatus = {
        concurrency: 5,
        isProcessing: false,
        pendingJobs: 0,
      };
      mockMessageProcessor.getWorkerStatus.mockReturnValue(workerStatus);
      mockMessageService.getMessageMergeStatus.mockReturnValue(true);

      const result = controller.getWorkerStatus();

      expect(messageProcessor.getWorkerStatus).toHaveBeenCalled();
      expect(messageService.getMessageMergeStatus).toHaveBeenCalled();
      expect(result).toEqual({
        ...workerStatus,
        messageMergeEnabled: true,
      });
    });

    it('should reflect disabled message merge in combined status', () => {
      mockMessageProcessor.getWorkerStatus.mockReturnValue({ concurrency: 3 });
      mockMessageService.getMessageMergeStatus.mockReturnValue(false);

      const result = controller.getWorkerStatus();

      expect(result.messageMergeEnabled).toBe(false);
    });
  });

  describe('setWorkerConcurrency', () => {
    it('should set concurrency via messageProcessor', async () => {
      const concurrency = 10;
      const mockResult = { success: true, concurrency: 10 };

      mockMessageProcessor.setConcurrency.mockResolvedValue(mockResult);

      const result = await controller.setWorkerConcurrency(concurrency);

      expect(messageProcessor.setConcurrency).toHaveBeenCalledWith(10);
      expect(result).toEqual(mockResult);
    });

    it('should return failure when concurrency is undefined', async () => {
      const result = await controller.setWorkerConcurrency(undefined as unknown as number);

      expect(messageProcessor.setConcurrency).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, message: 'concurrency 参数必填' });
    });

    it('should return failure when concurrency is null', async () => {
      const result = await controller.setWorkerConcurrency(null as unknown as number);

      expect(messageProcessor.setConcurrency).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, message: 'concurrency 参数必填' });
    });

    it('should work with concurrency of 1', async () => {
      mockMessageProcessor.setConcurrency.mockResolvedValue({ success: true, concurrency: 1 });

      const result = await controller.setWorkerConcurrency(1);

      expect(messageProcessor.setConcurrency).toHaveBeenCalledWith(1);
      expect(result).toEqual({ success: true, concurrency: 1 });
    });
  });
});
