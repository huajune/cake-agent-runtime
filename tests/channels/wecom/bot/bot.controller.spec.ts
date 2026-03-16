import { Test, TestingModule } from '@nestjs/testing';
import { BotController } from '@wecom/bot/bot.controller';
import { BotService } from '@wecom/bot/bot.service';

describe('BotController', () => {
  let controller: BotController;
  let service: BotService;

  const mockBotService = {
    getBotList: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BotController],
      providers: [
        {
          provide: BotService,
          useValue: mockBotService,
        },
      ],
    }).compile();

    controller = module.get<BotController>(BotController);
    service = module.get<BotService>(BotService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getBotList', () => {
    it('should call botService.getBotList with token', async () => {
      const token = 'test-token';
      const mockResult = {
        data: [
          { botId: 'bot1', name: 'Bot 1', status: 'online' },
          { botId: 'bot2', name: 'Bot 2', status: 'offline' },
        ],
        total: 2,
      };

      mockBotService.getBotList.mockResolvedValue(mockResult);

      const result = await controller.getBotList(token);

      expect(service.getBotList).toHaveBeenCalledWith(token);
      expect(result).toEqual(mockResult);
    });

    it('should handle empty bot list', async () => {
      const token = 'test-token';
      const mockResult = { data: [], total: 0 };

      mockBotService.getBotList.mockResolvedValue(mockResult);

      const result = await controller.getBotList(token);

      expect(service.getBotList).toHaveBeenCalledWith(token);
      expect(result).toEqual(mockResult);
    });

    it('should handle single bot in list', async () => {
      const token = 'test-token';
      const mockResult = {
        data: [{ botId: 'bot1', name: 'Only Bot', status: 'online' }],
        total: 1,
      };

      mockBotService.getBotList.mockResolvedValue(mockResult);

      const result = await controller.getBotList(token);

      expect(service.getBotList).toHaveBeenCalledWith(token);
      expect(result).toEqual(mockResult);
    });

    it('should handle multiple bots with different statuses', async () => {
      const token = 'test-token';
      const mockResult = {
        data: [
          { botId: 'bot1', name: 'Bot 1', status: 'online' },
          { botId: 'bot2', name: 'Bot 2', status: 'offline' },
          { botId: 'bot3', name: 'Bot 3', status: 'maintenance' },
        ],
        total: 3,
      };

      mockBotService.getBotList.mockResolvedValue(mockResult);

      const result = await controller.getBotList(token);

      expect(service.getBotList).toHaveBeenCalledWith(token);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from botService.getBotList', async () => {
      const token = 'test-token';
      const error = new Error('Service error');

      mockBotService.getBotList.mockRejectedValue(error);

      await expect(controller.getBotList(token)).rejects.toThrow('Service error');
    });

    it('should handle invalid token error', async () => {
      const token = 'invalid-token';
      const error = new Error('Invalid token');

      mockBotService.getBotList.mockRejectedValue(error);

      await expect(controller.getBotList(token)).rejects.toThrow('Invalid token');
    });
  });
});
