import { Test, TestingModule } from '@nestjs/testing';
import { BotService } from '@wecom/bot/bot.service';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

describe('BotService', () => {
  let service: BotService;

  const mockHttpService = {
    get: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      bot: {
        list: jest.fn().mockReturnValue('https://api.example.com/bot/list'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<BotService>(BotService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBotList', () => {
    it('should return bot list on success', async () => {
      const token = 'test-token';
      const mockResult = {
        data: [
          { id: 'bot-1', name: 'Bot 1' },
          { id: 'bot-2', name: 'Bot 2' },
        ],
        total: 2,
      };

      mockHttpService.get.mockResolvedValue(mockResult);

      const result = await service.getBotList(token);

      expect(mockApiConfig.endpoints.bot.list).toHaveBeenCalled();
      expect(mockHttpService.get).toHaveBeenCalledWith('https://api.example.com/bot/list', {
        token,
      });
      expect(result).toEqual(mockResult);
    });

    it('should pass the token as a query parameter', async () => {
      const token = 'my-specific-token';
      mockHttpService.get.mockResolvedValue({ data: [] });

      await service.getBotList(token);

      expect(mockHttpService.get).toHaveBeenCalledWith(expect.any(String), {
        token: 'my-specific-token',
      });
    });

    it('should throw error when httpService.get fails', async () => {
      const token = 'test-token';
      const error = new Error('Network error');

      mockHttpService.get.mockRejectedValue(error);

      await expect(service.getBotList(token)).rejects.toThrow('Network error');
    });

    it('should re-throw API errors without wrapping', async () => {
      const token = 'test-token';
      const apiError = new Error('Unauthorized');

      mockHttpService.get.mockRejectedValue(apiError);

      await expect(service.getBotList(token)).rejects.toBe(apiError);
    });

    it('should return empty data array when no bots exist', async () => {
      const token = 'test-token';
      const emptyResult = { data: [], total: 0 };

      mockHttpService.get.mockResolvedValue(emptyResult);

      const result = await service.getBotList(token);

      expect(result).toEqual(emptyResult);
    });
  });
});
