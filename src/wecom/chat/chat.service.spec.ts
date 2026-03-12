import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from './chat.service';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

describe('ChatService', () => {
  let service: ChatService;

  const mockHttpService = {
    get: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      chat: {
        list: jest.fn().mockReturnValue('https://api.example.com/chat/list'),
        get: jest.fn().mockReturnValue('https://api.example.com/chat/get'),
      },
      message: {
        history: jest.fn().mockReturnValue('https://api.example.com/message/history'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getChatList', () => {
    it('should return chat list with only token', async () => {
      const token = 'test-token';
      const mockResult = { data: [{ chatId: 'chat-1' }], total: 1 };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getChatList(token);

      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/chat/list', {
        token,
      });
      expect(result).toEqual(mockResult);
    });

    it('should include iterator in params when provided', async () => {
      const token = 'test-token';
      const iterator = 'cursor-abc';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getChatList(token, iterator);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, iterator });
    });

    it('should include pageSize in params when provided', async () => {
      const token = 'test-token';
      const pageSize = 20;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getChatList(token, undefined, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), { token, pageSize });
    });

    it('should include all optional params when provided', async () => {
      const token = 'test-token';
      const iterator = 'cursor-xyz';
      const pageSize = 50;
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getChatList(token, iterator, pageSize);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        iterator,
        pageSize,
      });
    });

    it('should throw error when httpService.get fails', async () => {
      const token = 'test-token';
      mockHttpService.get.mockRejectedValue(new Error('API error'));

      await expect(service.getChatList(token)).rejects.toThrow('API error');
    });

    it('should not add iterator to params when iterator is undefined', async () => {
      const token = 'test-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getChatList(token, undefined);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('iterator');
    });

    it('should not add pageSize to params when pageSize is undefined', async () => {
      const token = 'test-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getChatList(token, undefined, undefined);

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('pageSize');
    });
  });

  describe('getMessageHistory', () => {
    it('should return message history with required params', async () => {
      const token = 'test-token';
      const pageSize = 20;
      const snapshotDay = '2024-01-15';
      const mockResult = { data: [{ msgId: 'msg-1' }], total: 1 };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getMessageHistory(token, pageSize, snapshotDay);

      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/message/history', {
        token,
        pageSize,
        snapshotDay,
      });
      expect(result).toEqual(mockResult);
    });

    it('should include seq in params when provided', async () => {
      const token = 'test-token';
      const pageSize = 20;
      const snapshotDay = '2024-01-15';
      const seq = 'seq-123';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getMessageHistory(token, pageSize, snapshotDay, seq);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token,
        pageSize,
        snapshotDay,
        seq,
      });
    });

    it('should not include seq when not provided', async () => {
      const token = 'test-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getMessageHistory(token, 10, '2024-01-15');

      const callArgs = mockHttpService.get.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty('seq');
    });

    it('should throw error when API call fails', async () => {
      const token = 'test-token';
      mockHttpService.get.mockRejectedValue(new Error('Network error'));

      await expect(service.getMessageHistory(token, 20, '2024-01-15')).rejects.toThrow(
        'Network error',
      );
    });
  });

  describe('getChatById', () => {
    it('should return chat info for given chatId', async () => {
      const token = 'test-token';
      const chatId = 'chat-abc-123';
      const mockResult = { chatId, name: 'Test Chat', type: 'private' };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getChatById(token, chatId);

      expect(mockApiConfig.endpoints.chat.get).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/chat/get', {
        token,
        chatId,
      });
      expect(result).toEqual(mockResult);
    });

    it('should throw error when chatId not found', async () => {
      const token = 'test-token';
      const chatId = 'nonexistent-chat';
      const error = new Error('Chat not found');

      mockHttpService.get.mockRejectedValue(error);

      await expect(service.getChatById(token, chatId)).rejects.toThrow('Chat not found');
    });

    it('should re-throw the original error', async () => {
      const token = 'test-token';
      const chatId = 'chat-123';
      const originalError = new Error('Unauthorized');

      mockHttpService.get.mockRejectedValue(originalError);

      await expect(service.getChatById(token, chatId)).rejects.toBe(originalError);
    });
  });
});
