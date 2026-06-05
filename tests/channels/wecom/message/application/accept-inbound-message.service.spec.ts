import { AcceptInboundMessageService } from '@channels/wecom/message/application/accept-inbound-message.service';
import { EnterpriseMessageCallbackDto } from '@channels/wecom/message/ingress/message-callback.dto';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';
import { FilterReason } from '@enums/message-filter.enum';

describe('AcceptInboundMessageService', () => {
  const deduplicationService = {
    markMessageAsProcessedAsync: jest.fn(),
    isMessageProcessedAsync: jest.fn(),
  };
  const chatSession = {
    saveMessage: jest.fn(),
    getChatSessionMessages: jest.fn(),
  };
  const filterService = {
    validate: jest.fn(),
  };
  const imageDescription = {
    describeAndUpdateAsync: jest.fn(),
    awaitVision: jest.fn(),
    resolveArtworkUrl: jest.fn(),
  };
  const wecomObservability = {
    markHistoryStored: jest.fn(),
    hasTrace: jest.fn(),
    startRequestTrace: jest.fn(),
    buildFailureMetadata: jest.fn(),
    markImagePrepared: jest.fn(),
  };
  const monitoringService = {
    recordFailure: jest.fn(),
  };
  const runtimeConfig = {
    resolveWecomChatModelSelection: jest.fn(),
  };
  const llm = {
    supportsVisionInput: jest.fn(),
  };
  const longTerm = {
    updateMessageMetadata: jest.fn(),
  };
  const opsEventsRecorder = {
    recordEvent: jest.fn().mockResolvedValue(true),
    recordCandidateMessage: jest.fn().mockResolvedValue({ messageRecorded: true, engaged: false }),
  };
  const botGroupResolver = {
    resolveAgentId: jest.fn().mockReturnValue(null),
  };
  const huajuneReporter = {
    reportMessageReceived: jest.fn(),
    reportCandidateContacted: jest.fn(),
  };

  let service: AcceptInboundMessageService;

  beforeEach(() => {
    jest.clearAllMocks();
    deduplicationService.markMessageAsProcessedAsync.mockResolvedValue(undefined);
    deduplicationService.isMessageProcessedAsync.mockResolvedValue(false);
    chatSession.saveMessage.mockResolvedValue(undefined);
    chatSession.getChatSessionMessages.mockResolvedValue({
      messages: [{ role: 'user', candidateName: '候选人A' }],
    });
    filterService.validate.mockResolvedValue({ pass: true, content: '你好' });
    wecomObservability.hasTrace.mockResolvedValue(false);
    wecomObservability.startRequestTrace.mockResolvedValue(undefined);
    wecomObservability.markHistoryStored.mockResolvedValue(undefined);
    wecomObservability.buildFailureMetadata.mockResolvedValue({ traceId: 'msg-1' });
    wecomObservability.markImagePrepared.mockResolvedValue(undefined);
    runtimeConfig.resolveWecomChatModelSelection.mockResolvedValue({
      overrideModelId: 'gpt-test',
    });
    llm.supportsVisionInput.mockReturnValue(true);
    longTerm.updateMessageMetadata.mockResolvedValue(undefined);
    imageDescription.resolveArtworkUrl.mockImplementation((_id: string, url: string) =>
      Promise.resolve(url),
    );
    service = new AcceptInboundMessageService(
      deduplicationService as never,
      chatSession as never,
      filterService as never,
      imageDescription as never,
      wecomObservability as never,
      monitoringService as never,
      runtimeConfig as never,
      llm as never,
      longTerm as never,
      opsEventsRecorder as never,
      botGroupResolver as never,
      huajuneReporter as never,
    );
  });

  it('should store self messages as assistant history and skip dispatch', async () => {
    const message = createMessage({
      isSelf: true,
      messageId: 'msg-self',
      payload: {
        text: '我先帮你确认一下',
        pureText: '我先帮你确认一下',
      },
    });

    await expect(service.execute(message)).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: 'Self message stored' },
    });
    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        candidateName: '候选人A',
        content: '我先帮你确认一下',
      }),
    );
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-self');
    expect(filterService.validate).not.toHaveBeenCalled();
  });

  it('should record paused-user messages to history only', async () => {
    filterService.validate.mockResolvedValueOnce({
      pass: true,
      content: '候选人发来消息',
      historyOnly: true,
      reason: FilterReason.USER_PAUSED,
    });

    await expect(service.execute(createMessage())).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: 'Message recorded to history only' },
    });
    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: '候选人发来消息',
      }),
    );
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
  });

  it('should archive filtered personal inbound messages without dispatching', async () => {
    filterService.validate.mockResolvedValueOnce({
      pass: false,
      reason: FilterReason.INVALID_SOURCE,
    });

    await expect(
      service.execute(
        createMessage({
          source: MessageSource.AGGREGATED_CHAT_MANUAL,
          payload: {
            text: '这条也要能在后台看到',
            pureText: '这条也要能在后台看到',
          },
        }),
      ),
    ).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: `${FilterReason.INVALID_SOURCE} ignored` },
    });

    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: '这条也要能在后台看到',
        source: MessageSource.AGGREGATED_CHAT_MANUAL,
      }),
    );
    expect(wecomObservability.startRequestTrace).not.toHaveBeenCalled();
    expect(deduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalled();
  });

  it('首条真实消息（破冰）触发 friend.added 并开户长期记忆', async () => {
    opsEventsRecorder.recordCandidateMessage.mockResolvedValueOnce({
      messageRecorded: true,
      engaged: true,
    });

    await service.execute(
      createMessage({
        messageId: 'msg-first',
        externalUserId: 'external-1',
        avatar: 'https://example.com/avatar.png',
      }),
    );
    await flushMicrotasks();

    // 候选人首条真实消息（破冰）即新好友首次接触 → friend.added（每候选人一次）
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'friend.added',
        idempotencyKey: 'im-contact-1:friend_added',
        userId: 'im-contact-1',
        sourceChannel: 'unknown',
      }),
    );
    // friend.added 首次插入时开户长期记忆元数据
    expect(longTerm.updateMessageMetadata).toHaveBeenCalledWith('corp-1', 'im-contact-1', {
      botId: 'bot-1',
      imBotId: 'im-bot-1',
      imContactId: 'im-contact-1',
      contactType: ContactType.PERSONAL_WECHAT,
      contactName: '张三',
      externalUserId: 'external-1',
      avatar: 'https://example.com/avatar.png',
    });
    // 不应再记 agent.opening_sent（开场白改由 reply-workflow 在首条对外回复时记）
    expect(opsEventsRecorder.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'agent.opening_sent' }),
    );
  });

  it('records candidate.message_received for a real inbound candidate message', async () => {
    await service.execute(createMessage());

    expect(opsEventsRecorder.recordCandidateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'corp-1',
        messageId: 'msg-1',
        userId: 'im-contact-1',
        sourceChannel: 'unknown',
      }),
    );
  });

  it('reports real inbound candidate messages to Huajune when bot has agent mapping', async () => {
    botGroupResolver.resolveAgentId.mockReturnValueOnce('gaoyaqi-cake-1');

    await service.execute(createMessage({ messageId: 'msg-huajune-inbound' }));
    await flushMicrotasks();

    expect(huajuneReporter.reportMessageReceived).toHaveBeenCalledWith({
      agentId: 'gaoyaqi-cake-1',
      candidateName: '张三',
      idempotencyKey: 'msg-huajune-inbound',
    });
  });

  it('加好友纯默认招呼语只记 friend.added，不记候选人消息/破冰', async () => {
    filterService.validate.mockResolvedValueOnce({ pass: true, content: '我是🍪' });

    await service.execute(createMessage({ messageId: 'msg-greet' }));
    await flushMicrotasks();

    expect(opsEventsRecorder.recordCandidateMessage).not.toHaveBeenCalled();
    expect(opsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'friend.added',
        idempotencyKey: 'im-contact-1:friend_added',
      }),
    );
    // 握手语首次插入 friend.added → 同样开户长期记忆
    expect(longTerm.updateMessageMetadata).toHaveBeenCalled();
  });

  it('带求职意图的「我是…」按真实候选人消息计入（不当作握手语）', async () => {
    filterService.validate.mockResolvedValueOnce({ pass: true, content: '我是找工作的' });

    await service.execute(createMessage({ messageId: 'msg-intent' }));
    await flushMicrotasks();

    expect(opsEventsRecorder.recordCandidateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-intent', userId: 'im-contact-1' }),
    );
  });

  it('should not archive terminal filtered reasons outside the allowlist', async () => {
    filterService.validate.mockResolvedValueOnce({
      pass: false,
      reason: FilterReason.SELF_MESSAGE,
      content: '机器人自己的消息不应归档为 user',
    });

    await expect(service.execute(createMessage())).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: `${FilterReason.SELF_MESSAGE} ignored` },
    });

    expect(chatSession.saveMessage).not.toHaveBeenCalled();
    expect(wecomObservability.startRequestTrace).not.toHaveBeenCalled();
    expect(deduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalled();
  });

  it('should ignore duplicate inbound messages before dispatching', async () => {
    deduplicationService.isMessageProcessedAsync.mockResolvedValueOnce(true);

    await expect(service.execute(createMessage())).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: 'Duplicate message ignored' },
    });
    expect(chatSession.saveMessage).not.toHaveBeenCalled();
  });

  describe('图片消息原图链路', () => {
    const COMPRESSED_URL = 'https://oss.example.com/compressed/thumb.jpg';
    const ARTWORK_URL = 'https://oss.example.com/artwork/original.jpg';

    function createImageMessage(overrides: Partial<EnterpriseMessageCallbackDto> = {}) {
      return createMessage({
        messageType: MessageType.IMAGE,
        payload: { imageUrl: COMPRESSED_URL, width: 96, height: 210, size: 8870 },
        ...overrides,
      });
    }

    it('enrichImagePayload 应在存记录前获取原图并写入 payload', async () => {
      imageDescription.resolveArtworkUrl.mockResolvedValue(ARTWORK_URL);

      const message = createImageMessage();
      await service.execute(message);

      // ① resolveArtworkUrl 被调用（唯一一次 API 调用）
      expect(imageDescription.resolveArtworkUrl).toHaveBeenCalledWith(
        'msg-1',
        COMPRESSED_URL,
        expect.objectContaining({ chatId: 'chat-1', imBotId: 'im-bot-1' }),
      );

      // ② payload 已被 enrichImagePayload 原地修改
      expect(message.payload).toHaveProperty('artworkUrl', ARTWORK_URL);

      // ③ 存记录时 payload 已含 artworkUrl（一次 INSERT 到位）
      await new Promise((resolve) => setImmediate(resolve));
      expect(chatSession.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ artworkUrl: ARTWORK_URL }),
        }),
      );
    });

    it('prepareImageIfNeeded 应使用 payload.artworkUrl 而非重新调 API', async () => {
      imageDescription.resolveArtworkUrl.mockResolvedValue(ARTWORK_URL);
      imageDescription.awaitVision.mockResolvedValue(undefined);
      llm.supportsVisionInput.mockReturnValue(false);

      await service.execute(createImageMessage());
      await new Promise((resolve) => setImmediate(resolve));

      // resolveArtworkUrl 只在 enrichImagePayload 调了一次
      expect(imageDescription.resolveArtworkUrl).toHaveBeenCalledTimes(1);

      // describeAndUpdateAsync 收到的是原图 URL（不是压缩图）
      expect(imageDescription.describeAndUpdateAsync).toHaveBeenCalledWith(
        'msg-1',
        ARTWORK_URL,
        MessageType.IMAGE,
      );
    });

    it('原图获取失败时应回退到压缩图，不阻塞流程', async () => {
      imageDescription.resolveArtworkUrl.mockResolvedValue(COMPRESSED_URL);
      imageDescription.awaitVision.mockResolvedValue(undefined);
      llm.supportsVisionInput.mockReturnValue(false);

      const message = createImageMessage();
      await service.execute(message);
      await new Promise((resolve) => setImmediate(resolve));

      // payload 不应写入 artworkUrl（因为返回值 === 压缩图）
      expect(message.payload).not.toHaveProperty('artworkUrl');

      // vision 描述仍然用压缩图继续（降级而非报错）
      expect(imageDescription.describeAndUpdateAsync).toHaveBeenCalledWith(
        'msg-1',
        COMPRESSED_URL,
        MessageType.IMAGE,
      );
    });

    it('自发图片消息也应获取原图后再存记录', async () => {
      imageDescription.resolveArtworkUrl.mockResolvedValue(ARTWORK_URL);

      const message = createImageMessage({
        isSelf: true,
        source: MessageSource.AGGREGATED_CHAT_MANUAL,
        messageId: 'msg-self-img',
      });

      await service.execute(message);

      expect(imageDescription.resolveArtworkUrl).toHaveBeenCalled();
      expect(chatSession.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          payload: expect.objectContaining({ artworkUrl: ARTWORK_URL }),
        }),
      );
    });
  });
});

/** 刷新 fire-and-forget 异步事件记录的微任务队列，便于断言。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createMessage(
  overrides: Partial<EnterpriseMessageCallbackDto> = {},
): EnterpriseMessageCallbackDto {
  return {
    orgId: 'corp-1',
    token: 'token-1',
    botId: 'bot-1',
    botUserId: 'manager-1',
    imBotId: 'im-bot-1',
    chatId: 'chat-1',
    imContactId: 'im-contact-1',
    messageType: MessageType.TEXT,
    messageId: 'msg-1',
    timestamp: '1713168000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: {
      text: '你好',
      pureText: '你好',
    },
    contactName: '张三',
    _apiType: 'enterprise',
    ...overrides,
  } as EnterpriseMessageCallbackDto;
}
