import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from '@wecom/chat/chat.controller';
import { ChatService } from '@wecom/chat/chat.service';

describe('ChatController', () => {
  let controller: ChatController;
  let service: ChatService;

  const mockChatService = {
    getChatList: jest.fn(),
    getMessageHistory: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        {
          provide: ChatService,
          useValue: mockChatService,
        },
      ],
    }).compile();

    controller = module.get<ChatController>(ChatController);
    service = module.get<ChatService>(ChatService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getChatList', () => {
    it('should call chatService.getChatList with correct parameters', async () => {
      const token = 'test-token';
      const iterator = 'test-iterator';
      const pageSize = 10;
      const mockResult = { data: [], total: 0 };

      mockChatService.getChatList.mockResolvedValue(mockResult);

      const result = await controller.getChatList(token, iterator, pageSize);

      expect(service.getChatList).toHaveBeenCalledWith(token, iterator, pageSize);
      expect(result).toEqual(mockResult);
    });

    it('should call chatService.getChatList without optional parameters', async () => {
      const token = 'test-token';
      const mockResult = { data: [], total: 0 };

      mockChatService.getChatList.mockResolvedValue(mockResult);

      const result = await controller.getChatList(token);

      expect(service.getChatList).toHaveBeenCalledWith(token, undefined, undefined);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from chatService.getChatList', async () => {
      const token = 'test-token';
      const error = new Error('Service error');

      mockChatService.getChatList.mockRejectedValue(error);

      await expect(controller.getChatList(token)).rejects.toThrow('Service error');
    });
  });

  describe('getMessageHistory', () => {
    it('should call chatService.getMessageHistory with correct parameters', async () => {
      const token = 'test-token';
      const pageSize = 5;
      const snapshotDay = '2025-10-10';
      const seq = 'test-seq';
      const mockResult = { messages: [] };

      mockChatService.getMessageHistory.mockResolvedValue(mockResult);

      const result = await controller.getMessageHistory(token, pageSize, snapshotDay, seq);

      expect(service.getMessageHistory).toHaveBeenCalledWith(token, pageSize, snapshotDay, seq);
      expect(result).toEqual(mockResult);
    });

    it('should call chatService.getMessageHistory without optional seq parameter', async () => {
      const token = 'test-token';
      const pageSize = 5;
      const snapshotDay = '2025-10-10';
      const mockResult = { messages: [] };

      mockChatService.getMessageHistory.mockResolvedValue(mockResult);

      const result = await controller.getMessageHistory(token, pageSize, snapshotDay);

      expect(service.getMessageHistory).toHaveBeenCalledWith(
        token,
        pageSize,
        snapshotDay,
        undefined,
      );
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from chatService.getMessageHistory', async () => {
      const token = 'test-token';
      const pageSize = 5;
      const snapshotDay = '2025-10-10';
      const error = new Error('Service error');

      mockChatService.getMessageHistory.mockRejectedValue(error);

      await expect(controller.getMessageHistory(token, pageSize, snapshotDay)).rejects.toThrow(
        'Service error',
      );
    });
  });
});
