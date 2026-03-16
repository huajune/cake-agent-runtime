import { Test, TestingModule } from '@nestjs/testing';
import { MessageSenderController } from '@wecom/message-sender/message-sender.controller';
import { MessageSenderService } from '@wecom/message-sender/message-sender.service';
import { SendMessageDto, MessageType } from '@wecom/message-sender/dto/send-message.dto';
import { CreateBroadcastDto } from '@wecom/message-sender/dto/create-broadcast.dto';

describe('MessageSenderController', () => {
  let controller: MessageSenderController;
  let service: MessageSenderService;

  const mockMessageSenderService = {
    sendMessage: jest.fn(),
    createBroadcast: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessageSenderController],
      providers: [
        {
          provide: MessageSenderService,
          useValue: mockMessageSenderService,
        },
      ],
    }).compile();

    controller = module.get<MessageSenderController>(MessageSenderController);
    service = module.get<MessageSenderService>(MessageSenderService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('sendMessage', () => {
    it('should call messageSenderService.sendMessage with correct dto (private chat)', async () => {
      const mockDto: SendMessageDto = {
        token: 'test-token',
        imBotId: 'wxid_bot123',
        imContactId: 'wxid_customer789',
        messageType: MessageType.TEXT,
        payload: { text: 'Hello' },
      };
      const mockResult = { errcode: 0, errmsg: 'success', requestId: 'req123' };

      mockMessageSenderService.sendMessage.mockResolvedValue(mockResult);

      const result = await controller.sendMessage(mockDto);

      expect(service.sendMessage).toHaveBeenCalledWith(mockDto);
      expect(result).toEqual(mockResult);
    });

    it('should handle group chat message', async () => {
      const mockDto: SendMessageDto = {
        token: 'test-token',
        imBotId: 'wxid_bot123',
        imRoomId: '12345678@chatroom',
        messageType: MessageType.TEXT,
        payload: { text: 'Group message' },
      };
      const mockResult = { errcode: 0, errmsg: 'success', requestId: 'req456' };

      mockMessageSenderService.sendMessage.mockResolvedValue(mockResult);

      const result = await controller.sendMessage(mockDto);

      expect(service.sendMessage).toHaveBeenCalledWith(mockDto);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from messageSenderService.sendMessage', async () => {
      const mockDto: SendMessageDto = {
        token: 'test-token',
        imBotId: 'wxid_bot123',
        imContactId: 'wxid_customer789',
        messageType: MessageType.TEXT,
        payload: { text: 'Hello' },
      };
      const error = new Error('Send failed');

      mockMessageSenderService.sendMessage.mockRejectedValue(error);

      await expect(controller.sendMessage(mockDto)).rejects.toThrow('Send failed');
    });
  });

  describe('createBroadcast', () => {
    it('should call messageSenderService.createBroadcast with correct dto', async () => {
      const mockDto: CreateBroadcastDto = {
        token: 'test-token',
        messages: [{ payload: { text: 'Broadcast message' }, type: 0 }],
        members: [{ botUserId: 'bot1', wxids: ['user1', 'user2', 'user3'] }],
        hasMore: false,
        type: 0,
      };
      const mockResult = { success: true, taskId: 'task123' };

      mockMessageSenderService.createBroadcast.mockResolvedValue(mockResult);

      const result = await controller.createBroadcast(mockDto);

      expect(service.createBroadcast).toHaveBeenCalledWith(mockDto);
      expect(result).toEqual(mockResult);
    });

    it('should handle broadcast to multiple users', async () => {
      const mockDto: CreateBroadcastDto = {
        token: 'test-token',
        messages: [{ payload: { text: 'Mass message' }, type: 0 }],
        members: [{ botUserId: 'bot1', wxids: ['user1', 'user2', 'user3', 'user4', 'user5'] }],
        hasMore: false,
        type: 0,
      };
      const mockResult = { success: true, sentCount: 5 };

      mockMessageSenderService.createBroadcast.mockResolvedValue(mockResult);

      const result = await controller.createBroadcast(mockDto);

      expect(service.createBroadcast).toHaveBeenCalledWith(mockDto);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from messageSenderService.createBroadcast', async () => {
      const mockDto: CreateBroadcastDto = {
        token: 'test-token',
        messages: [{ payload: { text: 'Test' }, type: 0 }],
        members: [{ botUserId: 'bot1', wxids: ['user1'] }],
        hasMore: false,
        type: 0,
      };
      const error = new Error('Broadcast failed');

      mockMessageSenderService.createBroadcast.mockRejectedValue(error);

      await expect(controller.createBroadcast(mockDto)).rejects.toThrow('Broadcast failed');
    });
  });
});
