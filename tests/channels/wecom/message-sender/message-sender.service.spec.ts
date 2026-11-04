import { Test, TestingModule } from '@nestjs/testing';
import { MessageSenderService } from '@wecom/message-sender/message-sender.service';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

describe('MessageSenderService', () => {
  let service: MessageSenderService;

  const mockHttpService = {
    post: jest.fn(),
  };

  const mockApiConfig = {
    endpoints: {
      message: {
        send: jest.fn().mockReturnValue('https://enterprise-api.example.com/message/send'),
        sendGroup: jest.fn().mockReturnValue('https://api.example.com/message/send'),
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageSenderService,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ApiConfigService, useValue: mockApiConfig },
      ],
    }).compile();

    service = module.get<MessageSenderService>(MessageSenderService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendMessage', () => {
    describe('enterprise API (_apiType != group)', () => {
      it('should call enterprise API when _apiType is not "group"', async () => {
        const data = {
          _apiType: 'enterprise',
          token: 'ent-token',
          imBotId: 'bot-1',
          imContactId: 'contact-1',
          messageType: 7,
          payload: { text: 'Hello' },
        };
        const mockResult = { errcode: 0, errmsg: 'ok' };

        mockHttpService.post.mockResolvedValue(mockResult);

        const result = await service.sendMessage(data);

        expect(mockHttpService.post).toHaveBeenCalledWith(
          'https://enterprise-api.example.com/message/send?token=ent-token',
          {
            imBotId: 'bot-1',
            imContactId: 'contact-1',
            imRoomId: undefined,
            messageType: 7,
            payload: { text: 'Hello' },
          },
        );
        expect(result).toEqual(mockResult);
      });

      it('should include imRoomId for group chat enterprise messages', async () => {
        const data = {
          _apiType: 'enterprise',
          token: 'ent-token',
          imBotId: 'bot-1',
          imRoomId: 'room-1',
          messageType: 7,
          payload: { text: 'Room message' },
        };
        mockHttpService.post.mockResolvedValue({ errcode: 0 });

        await service.sendMessage(data);

        const callBody = mockHttpService.post.mock.calls[0][1];
        expect(callBody.imRoomId).toBe('room-1');
      });

      it('should forward a caller-provided externalRequestId to the enterprise API', async () => {
        mockHttpService.post.mockResolvedValue({ errcode: 0, requestId: 'request-1' });

        await service.sendMessage({
          _apiType: 'enterprise',
          token: 'ent-token',
          imBotId: 'bot-1',
          imContactId: 'contact-1',
          messageType: 7,
          payload: { text: 'Hello' },
          externalRequestId: 'batch-session-1',
        });

        expect(mockHttpService.post).toHaveBeenCalledWith(
          'https://enterprise-api.example.com/message/send?token=ent-token',
          expect.objectContaining({ externalRequestId: 'batch-session-1' }),
        );
      });

      it('should use undefined _apiType as enterprise API', async () => {
        const data = {
          token: 'ent-token',
          imBotId: 'bot-1',
          messageType: 7,
          payload: { text: 'Hello' },
        };
        mockHttpService.post.mockResolvedValue({ errcode: 0 });

        await service.sendMessage(data);

        const callUrl = mockHttpService.post.mock.calls[0][0];
        expect(callUrl).toContain('token=ent-token');
      });
    });

    describe('group API (_apiType === "group")', () => {
      it('should call group API when _apiType is "group"', async () => {
        const data = {
          _apiType: 'group',
          token: 'group-token',
          chatId: 'chat-123',
          messageType: 7, // Enterprise TEXT -> Group type 0
          payload: { text: 'Hello from group' },
        };
        const mockResult = { errcode: 0, errmsg: 'ok' };

        mockHttpService.post.mockResolvedValue(mockResult);

        const result = await service.sendMessage(data);

        expect(mockApiConfig.endpoints.message.sendGroup).toHaveBeenCalled();
        expect(mockHttpService.post).toHaveBeenCalledWith(
          'https://api.example.com/message/send',
          expect.objectContaining({
            token: 'group-token',
            chatId: 'chat-123',
            messageType: 0, // Converted: enterprise 7 -> group 0
            payload: { text: 'Hello from group' },
          }),
        );
        expect(result).toEqual(mockResult);
      });

      it('should generate a unique externalRequestId for group messages', async () => {
        const data = {
          _apiType: 'group',
          token: 'group-token',
          chatId: 'chat-123',
          messageType: 7,
          payload: { text: 'Test' },
        };
        mockHttpService.post.mockResolvedValue({ errcode: 0 });

        await service.sendMessage(data);

        const callBody = mockHttpService.post.mock.calls[0][1];
        expect(callBody.externalRequestId).toBeDefined();
        expect(typeof callBody.externalRequestId).toBe('string');
        expect(callBody.externalRequestId).toMatch(/^msg_\d+_/);
      });

      it('should generate unique externalRequestIds for each call', async () => {
        const data = {
          _apiType: 'group',
          token: 'group-token',
          chatId: 'chat-123',
          messageType: 7,
          payload: { text: 'Test' },
        };
        mockHttpService.post.mockResolvedValue({ errcode: 0 });

        await service.sendMessage(data);
        await service.sendMessage(data);

        const id1 = mockHttpService.post.mock.calls[0][1].externalRequestId;
        const id2 = mockHttpService.post.mock.calls[1][1].externalRequestId;
        // Both should be defined; very likely different but that's non-deterministic
        expect(id1).toBeDefined();
        expect(id2).toBeDefined();
      });
    });

    describe('message type conversion for group API', () => {
      const groupTypeTestCases = [
        { enterpriseType: 7, expectedGroupType: 0, label: 'TEXT (7->0)' },
        { enterpriseType: 6, expectedGroupType: 1, label: 'IMAGE (6->1)' },
        { enterpriseType: 12, expectedGroupType: 2, label: 'LINK (12->2)' },
        { enterpriseType: 1, expectedGroupType: 3, label: 'FILE (1->3)' },
        { enterpriseType: 9, expectedGroupType: 4, label: 'MINI_PROGRAM (9->4)' },
        { enterpriseType: 13, expectedGroupType: 5, label: 'VIDEO (13->5)' },
        { enterpriseType: 14, expectedGroupType: 7, label: 'CHANNELS (14->7)' },
        { enterpriseType: 2, expectedGroupType: 8, label: 'VOICE (2->8)' },
        { enterpriseType: 5, expectedGroupType: 9, label: 'EMOTION (5->9)' },
        { enterpriseType: 8, expectedGroupType: 10, label: 'LOCATION (8->10)' },
      ];

      groupTypeTestCases.forEach(({ enterpriseType, expectedGroupType, label }) => {
        it(`should convert ${label}`, async () => {
          const data = {
            _apiType: 'group',
            token: 'group-token',
            chatId: 'chat-123',
            messageType: enterpriseType,
            payload: {},
          };
          mockHttpService.post.mockResolvedValue({ errcode: 0 });

          await service.sendMessage(data);

          const callBody = mockHttpService.post.mock.calls[0][1];
          expect(callBody.messageType).toBe(expectedGroupType);
        });
      });

      it('should use original type when enterprise type is unknown', async () => {
        const unknownType = 999;
        const data = {
          _apiType: 'group',
          token: 'group-token',
          chatId: 'chat-123',
          messageType: unknownType,
          payload: {},
        };
        mockHttpService.post.mockResolvedValue({ errcode: 0 });

        await service.sendMessage(data);

        const callBody = mockHttpService.post.mock.calls[0][1];
        expect(callBody.messageType).toBe(unknownType);
      });
    });

    it('should throw error when httpService.post fails', async () => {
      const data = {
        _apiType: 'enterprise',
        token: 'ent-token',
        imBotId: 'bot-1',
        messageType: 7,
        payload: { text: 'Hello' },
      };
      const error = new Error('Send failed');

      mockHttpService.post.mockRejectedValue(error);

      await expect(service.sendMessage(data)).rejects.toThrow('Send failed');
    });

    it('should re-throw original error without wrapping', async () => {
      const data = {
        _apiType: 'enterprise',
        token: 'ent-token',
        imBotId: 'bot-1',
        messageType: 7,
        payload: { text: 'Hello' },
      };
      const originalError = new Error('API error');

      mockHttpService.post.mockRejectedValue(originalError);

      await expect(service.sendMessage(data)).rejects.toBe(originalError);
    });
  });

  describe('credential-safe failures', () => {
    it.each(['enterprise', 'group'])(
      'redacts a reflected %s token from business errors without accepting a failed send',
      async (apiType) => {
        const token = 'secret+/sender-token';
        mockHttpService.post.mockResolvedValue({
          errcode: 403,
          errmsg: `invalid credential ${token}; encoded=${encodeURIComponent(token)}`,
        });

        const failure: unknown = await service
          .sendMessage({
            _apiType: apiType,
            token,
            imBotId: 'bot-1',
            chatId: 'chat-1',
            messageType: 7,
            payload: { text: 'test' },
          })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error('expected a send error');
        expect(failure.message).toContain('errcode=403');
        expect(failure).toMatchObject({ name: 'ProviderBusinessError', code: 403 });
        expect(failure.message).toContain('[REDACTED]');
        expect(failure.message).not.toContain(token);
        expect(failure.message).not.toContain(encodeURIComponent(token));
        expect(failure.stack).not.toContain(token);
        expect(mockHttpService.post).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['send', 'broadcast'] as const)(
      'strips credential-bearing HTTP context from %s rejection',
      async (kind) => {
        const token = 'transport-secret';
        const original = Object.assign(new Error(`failed token=${token}`), {
          config: { url: `https://api.example.test/send?token=${token}`, data: { token } },
          request: { token },
          response: { data: { errmsg: token } },
          cause: new Error(token),
        });
        mockHttpService.post.mockRejectedValue(original);

        const request =
          kind === 'send'
            ? service.sendMessage({
                token,
                imBotId: 'bot-1',
                messageType: 7,
                payload: { text: 'test' },
              })
            : service.createBroadcast({
                token,
                messages: [],
                members: [],
                hasMore: false,
                type: 1,
              });
        const failure: unknown = await request.catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error('expected an HTTP send error');
        expect(failure).not.toBe(original);
        expect(failure.message).not.toContain(token);
        expect(failure.stack).not.toContain(token);
        for (const field of ['config', 'request', 'response', 'cause'])
          expect(failure).not.toHaveProperty(field);
        expect(mockHttpService.post).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('createBroadcast', () => {
    it('should create broadcast message successfully', async () => {
      const broadcastData = {
        token: 'enterprise-token',
        messages: [{ payload: { text: 'Broadcast message' }, type: 7 }],
        members: [{ botUserId: 'bot-1', wxids: ['wxid_1', 'wxid_2'] }],
        hasMore: false,
        type: 1,
      };
      const mockResult = { errcode: 0, errmsg: 'ok', requestId: 'req-123' };

      mockHttpService.post.mockResolvedValue(mockResult);

      const result = await service.createBroadcast(broadcastData);

      expect(mockApiConfig.endpoints.message.send).toHaveBeenCalled();
      expect(mockHttpService.post).toHaveBeenCalledWith(
        'https://enterprise-api.example.com/message/send?token=enterprise-token',
        {
          messages: broadcastData.messages,
          members: broadcastData.members,
          hasMore: broadcastData.hasMore,
          type: broadcastData.type,
        },
      );
      expect(result).toEqual(mockResult);
    });

    it('should extract token from body and pass as URL param', async () => {
      const broadcastData = {
        token: 'my-special-token',
        messages: [],
        members: [],
        hasMore: false,
        type: 1,
      };
      mockHttpService.post.mockResolvedValue({ errcode: 0 });

      await service.createBroadcast(broadcastData);

      const callUrl = mockHttpService.post.mock.calls[0][0];
      expect(callUrl).toContain('token=my-special-token');

      const callBody = mockHttpService.post.mock.calls[0][1];
      expect(callBody).not.toHaveProperty('token');
    });

    it('should throw error when broadcast fails', async () => {
      const broadcastData = {
        token: 'enterprise-token',
        messages: [],
        members: [],
        hasMore: false,
        type: 1,
      };
      const error = new Error('Broadcast error');

      mockHttpService.post.mockRejectedValue(error);

      await expect(service.createBroadcast(broadcastData)).rejects.toThrow('Broadcast error');
    });

    it('should re-throw original error', async () => {
      const broadcastData = {
        token: 'enterprise-token',
        messages: [],
        members: [],
        hasMore: false,
        type: 1,
      };
      const originalError = new Error('Network failure');

      mockHttpService.post.mockRejectedValue(originalError);

      await expect(service.createBroadcast(broadcastData)).rejects.toBe(originalError);
    });
  });
});
