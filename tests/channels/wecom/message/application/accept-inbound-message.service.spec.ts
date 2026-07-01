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
    getChatHistory: jest.fn(),
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
  const session = {
    saveLastCandidateMessageAt: jest.fn(),
  };
  const opsEventsRecorder = {
    recordEvent: jest.fn().mockResolvedValue(true),
    recordCandidateMessage: jest.fn().mockResolvedValue({ messageRecorded: true, engaged: false }),
  };
  const userHostingService = {
    isAnyPaused: jest.fn(),
    pauseUser: jest.fn(),
  };
  const generalHandoffNotifier = {
    notify: jest.fn(),
  };
  const groupBlacklistService = {
    isGroupBlacklisted: jest.fn(),
  };

  let service: AcceptInboundMessageService;

  beforeEach(() => {
    jest.clearAllMocks();
    deduplicationService.markMessageAsProcessedAsync.mockResolvedValue(true);
    deduplicationService.isMessageProcessedAsync.mockResolvedValue(false);
    chatSession.saveMessage.mockResolvedValue(undefined);
    chatSession.getChatSessionMessages.mockResolvedValue({
      messages: [{ role: 'user', candidateName: '候选人A' }],
    });
    chatSession.getChatHistory.mockResolvedValue([
      { messageId: 'm1', role: 'user', content: '我还要等几天', timestamp: 1713168000000 },
      { messageId: 'm2', role: 'assistant', content: '我来跟进一下', timestamp: 1713168001000 },
    ]);
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
    session.saveLastCandidateMessageAt.mockResolvedValue(undefined);
    userHostingService.isAnyPaused.mockResolvedValue({ paused: false });
    userHostingService.pauseUser.mockResolvedValue(undefined);
    generalHandoffNotifier.notify.mockResolvedValue(true);
    groupBlacklistService.isGroupBlacklisted.mockResolvedValue(false);
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
      session as never,
      opsEventsRecorder as never,
      userHostingService as never,
      generalHandoffNotifier as never,
      groupBlacklistService as never,
    );
  });

  it('should store self messages as assistant history and skip dispatch', async () => {
    // AI 自己经 API 发出的回复（source=API_SEND）回显为自发消息：存为 assistant 历史、
    // 不触发派发，且**不得**被当成真人介入而暂停托管。
    const message = createMessage({
      isSelf: true,
      source: MessageSource.API_SEND,
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
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
  });

  it('records last candidate message timestamp for reengagement stop conditions', async () => {
    const result = await service.execute(createMessage({ timestamp: '1713168001234' }));

    expect(result.shouldDispatch).toBe(true);
    expect(session.saveLastCandidateMessageAt).toHaveBeenCalledWith(
      'corp-1',
      'im-contact-1',
      'chat-1',
      1713168001234,
    );
  });

  it('真人手机手打暗号「~」后自动暂停该候选人托管', async () => {
    // 真人招募经理介入主力形态是经理在托管号手机上手打（isSelf=true + MOBILE_PUSH）；
    // 仅当手打内容恰好为暂停暗号「~」时才触发自动暂停，避免日常正常回复被误判。
    const message = createMessage({
      isSelf: true,
      source: MessageSource.MOBILE_PUSH,
      messageId: 'msg-human',
      payload: {
        text: '~',
        pureText: '~',
      },
    });

    await service.execute(message);

    expect(userHostingService.isAnyPaused).toHaveBeenCalledWith([
      'chat-1',
      'im-contact-1',
      undefined,
    ]);
    expect(userHostingService.pauseUser).toHaveBeenCalledWith('chat-1', {
      source: 'human_intervention',
      reason: '检测到真人介入聊天自动暂停',
    });
    // 复用「候选人需人工介入」通用卡片，但沿用原文案标题/说明（手机手打 → 来源短语「手机」）
    expect(generalHandoffNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        titleOverride: '🚨 真人介入聊天，已自动暂停托管',
        reason: '检测到真人通过手机手动发送消息，系统已自动暂停该候选人托管',
        corpId: 'corp-1',
        botImId: 'im-bot-1',
        botUserName: 'manager-1',
        // 微信昵称取自会话历史的真实候选人，而非自发消息里的托管号名
        contactName: '候选人A',
        chatId: 'chat-1',
        pausedUserId: 'chat-1',
        currentMessageContent: '~',
        recentMessages: [
          { role: 'user', content: '我还要等几天', timestamp: 1713168000000 },
          { role: 'assistant', content: '我来跟进一下', timestamp: 1713168001000 },
        ],
        sessionState: null,
        // 诊断载荷：透传命中链路原始字段，便于排查
        diagnostics: {
          botId: 'bot-1',
          imBotId: 'im-bot-1',
          imContactId: 'im-contact-1',
          externalUserId: undefined,
          source: MessageSource.MOBILE_PUSH,
          sourceDescription: '手机推送过来的消息',
          messageType: MessageType.TEXT,
        },
      }),
    );
    // 原文案无「建议动作」，不应传 actionAdvice
    expect(generalHandoffNotifier.notify.mock.calls[0][0].actionAdvice).toBeUndefined();
  });

  it('真人手机手打全角波浪线「～」也按暂停暗号处理', async () => {
    await service.execute(
      createMessage({
        isSelf: true,
        source: MessageSource.MOBILE_PUSH,
        messageId: 'msg-human-fullwidth-tilde',
        payload: {
          text: '～',
          pureText: '～',
        },
      }),
    );

    expect(userHostingService.pauseUser).toHaveBeenCalledWith('chat-1', {
      source: 'human_intervention',
      reason: '检测到真人介入聊天自动暂停',
    });
  });

  it('真人引用消息后回复暗号「~」仍应暂停托管', async () => {
    await service.execute(
      createMessage({
        isSelf: true,
        source: MessageSource.MOBILE_PUSH,
        messageId: 'msg-human-quoted-trigger',
        payload: {
          text: '~',
          pureText: '~',
          quoteMessage: {
            messageId: 'quoted-1',
            wxid: 'im-bot-1',
            nickname: 'manager-1',
            type: String(MessageType.TEXT),
            content: { text: '你是愿意继续考虑这个岗位吗？' },
            timestamp: '1713167999000',
          },
        },
      }),
    );

    expect(userHostingService.pauseUser).toHaveBeenCalledWith('chat-1', {
      source: 'human_intervention',
      reason: '检测到真人介入聊天自动暂停',
    });
  });

  it('真人手机手打普通文字（非暗号「~」）不触发暂停/告警', async () => {
    // 核心：经理日常正常回复（如"我来跟进一下"）不应被误判为介入而暂停托管，
    // 只有恰好等于约定暗号「~」才触发（避免误暂停 + 误告警，2026-06-17 李宇杭 case）。
    await service.execute(
      createMessage({
        isSelf: true,
        source: MessageSource.MOBILE_PUSH,
        messageId: 'msg-human-normal',
        payload: { text: '我来跟进一下', pureText: '我来跟进一下' },
      }),
    );

    expect(userHostingService.isAnyPaused).not.toHaveBeenCalled();
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(generalHandoffNotifier.notify).not.toHaveBeenCalled();
  });

  it('入群邀请卡片（ROOM_INVITE）回灌的自发消息不当人工介入处理', async () => {
    // 回归 2026-06-17 李宇杭 case：invite_to_group 成功后平台向候选人发出的入群邀请卡片，
    // 会以 isSelf=true + source=MOBILE_PUSH + messageType=ROOM_INVITE 回灌。仅 TEXT 才算真人介入，
    // 卡片非文字 → 不暂停托管 + 不告警。卡片本身仍存为占位历史。
    await service.execute(
      createMessage({
        isSelf: true,
        source: MessageSource.MOBILE_PUSH,
        messageType: MessageType.ROOM_INVITE,
        messageId: 'msg-human-invite',
        payload: { roomName: '独立客&上海餐饮兼职⑩群' },
      }),
    );

    expect(userHostingService.isAnyPaused).not.toHaveBeenCalled();
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(generalHandoffNotifier.notify).not.toHaveBeenCalled();
    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        messageType: MessageType.ROOM_INVITE,
        content: '[入群邀请] 邀请你加入"独立客&上海餐饮兼职⑩群"',
      }),
    );
  });

  it('真人手发非文字消息（语音等）不暂停托管，仅 TEXT 才算人工介入', async () => {
    // 人工介入只认真人手打文字：经理手机手发语音/图片/表情等非 TEXT 消息不触发暂停。
    await service.execute(
      createMessage({
        isSelf: true,
        source: MessageSource.MOBILE_PUSH,
        messageType: MessageType.VOICE,
        messageId: 'msg-human-voice',
        payload: { text: '[语音]', pureText: '[语音]' },
      }),
    );

    expect(userHostingService.isAnyPaused).not.toHaveBeenCalled();
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(generalHandoffNotifier.notify).not.toHaveBeenCalled();
  });

  it('未托管小组（已屏蔽）的真人回复不触发暂停/告警', async () => {
    // 与 Dashboard「小组托管状态」同源：小组在 group_blacklist（已屏蔽=关闭托管）时，
    // 招募经理在该小组真人回复属正常操作，不应进入暂停链路（否则误暂停 + 误告警）。
    groupBlacklistService.isGroupBlacklisted.mockResolvedValueOnce(true);

    await service.execute(
      createMessage({
        isSelf: true,
        source: MessageSource.MOBILE_PUSH,
        groupId: 'group-blocked',
        messageId: 'msg-human-unhosted',
        payload: { text: '~', pureText: '~' },
      }),
    );

    expect(groupBlacklistService.isGroupBlacklisted).toHaveBeenCalledWith('group-blocked');
    expect(userHostingService.isAnyPaused).not.toHaveBeenCalled();
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(generalHandoffNotifier.notify).not.toHaveBeenCalled();
  });

  it('真人手动介入命中已暂停候选人时不重复刷新暂停状态', async () => {
    userHostingService.isAnyPaused.mockResolvedValueOnce({
      paused: true,
      matchedId: 'chat-1',
    });

    await service.execute(
      createMessage({
        isSelf: true,
        source: MessageSource.MOBILE_PUSH,
        messageId: 'msg-human-paused',
        payload: {
          text: '~',
          pureText: '~',
        },
      }),
    );

    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(generalHandoffNotifier.notify).not.toHaveBeenCalled();
  });

  it('should store self room-invite cards with placeholder content (group name from payload)', async () => {
    const message = createMessage({
      isSelf: true,
      messageId: 'msg-self-invite',
      messageType: MessageType.ROOM_INVITE,
      source: MessageSource.API_SEND,
      payload: { roomName: '独立客&上海餐饮兼职⑩群' },
    });

    await expect(service.execute(message)).resolves.toEqual({
      shouldDispatch: false,
      response: { success: true, message: 'Self message stored' },
    });
    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        messageType: MessageType.ROOM_INVITE,
        content: '[入群邀请] 邀请你加入"独立客&上海餐饮兼职⑩群"',
      }),
    );
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(generalHandoffNotifier.notify).not.toHaveBeenCalled();
  });

  it('should store self room-invite cards with generic placeholder when payload has no group name', async () => {
    const message = createMessage({
      isSelf: true,
      messageId: 'msg-self-invite-2',
      messageType: MessageType.ROOM_INVITE,
      source: MessageSource.API_SEND,
      payload: {},
    });

    await service.execute(message);

    expect(chatSession.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: '[入群邀请] 已发送入群邀请卡片',
      }),
    );
  });

  it('should still skip self messages of other types with empty content', async () => {
    const message = createMessage({
      isSelf: true,
      messageId: 'msg-self-video',
      messageType: MessageType.VIDEO,
      source: MessageSource.API_SEND,
      payload: { videoUrl: 'http://example.com/v.mp4', duration: 5 },
    });

    await service.execute(message);

    expect(chatSession.saveMessage).not.toHaveBeenCalled();
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
    deduplicationService.markMessageAsProcessedAsync.mockResolvedValueOnce(false);

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
