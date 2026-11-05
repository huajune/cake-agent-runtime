import { GroupRouteCredentialsService } from '@wecom/message/credentials/group-route-credentials.service';
import { ReplyTurnsRepository } from '@biz/reply-execution/reply-turns.repository';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessageService } from '@wecom/message/message.service';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { MessageDeduplicationService } from '@wecom/message/runtime/deduplication.service';
import { MessagePipelineService } from '@wecom/message/application/pipeline.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { WecomMessageObservabilityService } from '@wecom/message/telemetry/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';
import { MessageRuntimeConfigService } from '@wecom/message/runtime/message-runtime-config.service';

describe('MessageService', () => {
  let service: MessageService;
  const replyRecords = { appendCallback: jest.fn() };
  const config = { get: jest.fn() };
  const groupCredentials = { verifyCallback: jest.fn() };

  const mockSimpleMergeService = {
    addMessage: jest.fn(),
  };

  const mockDeduplicationService = {
    clearAll: jest.fn(),
    markMessageAsProcessedAsync: jest.fn(),
  };

  const mockPipelineService = {
    execute: jest.fn(),
    processSingleMessage: jest.fn(),
    processMergedMessages: jest.fn(),
  };

  const mockMonitoringService = {
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };

  const mockWecomObservabilityService = {
    hasTrace: jest.fn().mockReturnValue(false),
    startTrace: jest.fn(),
    startRequestTrace: jest.fn(),
    updateDispatch: jest.fn(),
    buildSuccessMetadata: jest.fn(),
    buildFailureMetadata: jest.fn(),
  };

  const mockRuntimeConfigService = {
    isAiReplyEnabled: jest.fn(),
    isMessageMergeEnabled: jest.fn(),
    syncSnapshot: jest.fn().mockResolvedValue(undefined),
  };

  const validMessageData: EnterpriseMessageCallbackDto = {
    orgId: 'org-123',
    token: 'token-123',
    botId: 'bot-123',
    botUserId: 'manager-bob',
    imBotId: 'wxid-bot-123',
    chatId: 'chat-123',
    messageType: MessageType.TEXT,
    messageId: 'msg-123',
    timestamp: '1700000000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    imContactId: 'contact-123',
    contactName: 'Alice',
    payload: { text: 'Hello!' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: ReplyTurnsRepository, useValue: replyRecords },
        { provide: ConfigService, useValue: config },
        { provide: GroupRouteCredentialsService, useValue: groupCredentials },
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
        { provide: MessagePipelineService, useValue: mockPipelineService },
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservabilityService },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: MessageRuntimeConfigService, useValue: mockRuntimeConfigService },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
    jest.clearAllMocks();
    replyRecords.appendCallback.mockReset().mockResolvedValue(true);
    config.get.mockReset().mockReturnValue('token-123');
    groupCredentials.verifyCallback.mockReset().mockResolvedValue(null);

    mockRuntimeConfigService.isAiReplyEnabled.mockReturnValue(true);
    mockRuntimeConfigService.isMessageMergeEnabled.mockReturnValue(true);
    mockWecomObservabilityService.buildSuccessMetadata.mockReturnValue({
      replyPreview: '[AI回复已禁用]',
      replySegments: 0,
      extraResponse: { disabledAiReply: true },
    });
    mockWecomObservabilityService.buildFailureMetadata.mockReturnValue({
      alertType: 'merge',
    });
    mockPipelineService.execute.mockResolvedValue({
      shouldDispatch: true,
      response: { success: true, message: 'Message received' },
    });
    mockPipelineService.processSingleMessage.mockResolvedValue(undefined);
    mockPipelineService.processMergedMessages.mockResolvedValue(undefined);
    mockSimpleMergeService.addMessage.mockResolvedValue(undefined);
    mockDeduplicationService.markMessageAsProcessedAsync.mockResolvedValue(true);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should read current toggle states from runtime config', async () => {
      await service.onModuleInit();

      expect(mockRuntimeConfigService.isAiReplyEnabled).toHaveBeenCalled();
      expect(mockRuntimeConfigService.isMessageMergeEnabled).toHaveBeenCalled();
    });
  });

  describe('handleMessage', () => {
    it.each([{ token: 'token-456' }, { token: '' }, { _apiType: 'group' as const }])(
      'does not treat an unverified callback as terminal evidence: %j',
      async (override) => {
        await service.handleMessage({
          ...validMessageData,
          isSelf: true,
          source: MessageSource.API_SEND,
          externalRequestId: 'cake_registered_request',
          ...override,
        });
        expect(replyRecords.appendCallback).not.toHaveBeenCalled();
      },
    );

    it('matches group callbacks only within directory-verified legacy and actual corp scopes', async () => {
      groupCredentials.verifyCallback.mockResolvedValue({
        groupId: 'trusted-group',
        corpIds: ['group_callback_org', 'directory-corp'],
      });
      replyRecords.appendCallback.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await service.handleMessage({
        ...validMessageData,
        orgId: 'group_callback_org',
        _apiType: 'group',
        isSelf: true,
        source: MessageSource.API_SEND,
        externalRequestId: 'cake_group_request',
      });
      expect(replyRecords.appendCallback.mock.calls.map(([input]) => input.corpId)).toEqual([
        'group_callback_org',
        'directory-corp',
      ]);
      expect(replyRecords.appendCallback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: validMessageData.imBotId,
          chatId: validMessageData.chatId,
          requestId: 'cake_group_request',
          messageType: MessageType.TEXT,
        }),
      );
      await flushAsync();
      expect(mockPipelineService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'group_callback_org',
          groupId: 'trusted-group',
          _apiType: 'group',
        }),
      );
    });

    it('does not ACK a managed group callback when its trusted directory is unavailable', async () => {
      groupCredentials.verifyCallback.mockRejectedValue(
        new Error('group_route_credentials_unavailable'),
      );
      await expect(
        service.handleMessage({
          ...validMessageData,
          _apiType: 'group',
          isSelf: true,
          source: MessageSource.API_SEND,
          externalRequestId: 'cake_group_request',
        }),
      ).rejects.toThrow('group_route_credentials_unavailable');
      expect(replyRecords.appendCallback).not.toHaveBeenCalled();
      expect(mockPipelineService.execute).not.toHaveBeenCalled();
    });

    it('does not ACK a group callback before durable evidence is saved', async () => {
      groupCredentials.verifyCallback.mockResolvedValue({
        groupId: 'trusted-group',
        corpIds: ['group_callback_org'],
      });
      replyRecords.appendCallback.mockRejectedValue(new Error('evidence write timeout'));
      await expect(
        service.handleMessage({
          ...validMessageData,
          orgId: 'group_callback_org',
          _apiType: 'group',
          isSelf: true,
          source: MessageSource.AGGREGATED_CHAT_MANUAL,
          _sourceInferred: true,
          externalRequestId: 'cake_group_request',
        }),
      ).rejects.toThrow('evidence write timeout');
      expect(mockPipelineService.execute).not.toHaveBeenCalled();
    });

    it('freezes trusted group identity on new execute inputs without changing their legacy namespace', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'ACTION_EXECUTION_MODE' ? 'execute' : 'token-123',
      );
      groupCredentials.verifyCallback.mockResolvedValue({
        groupId: 'trusted-group',
        corpIds: ['group_callback_org', 'directory-corp'],
      });
      await service.handleMessage({
        ...validMessageData,
        orgId: 'group_callback_org',
        _apiType: 'group',
      });
      await flushAsync();
      expect(mockPipelineService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'group_callback_org',
          groupId: 'trusted-group',
          _apiType: 'group',
        }),
      );
      expect(replyRecords.appendCallback).not.toHaveBeenCalled();
    });

    it('rejects an unverified execute group input before enqueueing it', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'ACTION_EXECUTION_MODE' ? 'execute' : 'token-123',
      );
      await expect(
        service.handleMessage({ ...validMessageData, _apiType: 'group' }),
      ).rejects.toThrow('group_route_identity_unverified');
      expect(mockPipelineService.execute).not.toHaveBeenCalled();
      expect(mockSimpleMergeService.addMessage).not.toHaveBeenCalled();
    });

    it('keeps ordinary observe group inputs on the immediate-ACK legacy path', async () => {
      const response = service.handleMessage({ ...validMessageData, _apiType: 'group' });
      expect(response).toEqual({ success: true, message: 'Message received' });
      await flushAsync();
      expect(groupCredentials.verifyCallback).not.toHaveBeenCalled();
    });

    it('keeps callbacks unknown when the enterprise credential is unavailable', async () => {
      config.get.mockReturnValue(undefined);
      await service.handleMessage({
        ...validMessageData,
        isSelf: true,
        source: MessageSource.API_SEND,
        externalRequestId: 'cake_registered_request',
      });
      expect(replyRecords.appendCallback).not.toHaveBeenCalled();
    });

    it('accepts a trusted matching callback with an inferred source', async () => {
      await service.handleMessage({
        ...validMessageData,
        isSelf: true,
        source: MessageSource.AGGREGATED_CHAT_MANUAL,
        _sourceInferred: true,
        externalRequestId: 'cake_registered_request',
      });
      expect(replyRecords.appendCallback).toHaveBeenCalledTimes(1);
      await flushAsync();
    });
    it('does not treat explicit manual source as managed callback', async () => {
      await service.handleMessage({
        ...validMessageData,
        isSelf: true,
        source: MessageSource.AGGREGATED_CHAT_MANUAL,
        _sourceInferred: false,
        externalRequestId: 'cake_registered_request',
      });
      expect(replyRecords.appendCallback).not.toHaveBeenCalled();
      await flushAsync();
    });
    it('uses text when callback pureText is empty', async () => {
      await service.handleMessage({
        ...validMessageData,
        isSelf: true,
        source: MessageSource.API_SEND,
        externalRequestId: 'cake_registered_request',
        payload: { pureText: '', text: 'sent text' },
      });
      expect(replyRecords.appendCallback).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'sent text' }),
      );
      await flushAsync();
    });
    it('persists managed callback evidence before acknowledging it', async () => {
      let release!: (value: boolean) => void;
      replyRecords.appendCallback.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      const response = service.handleMessage({
        ...validMessageData,
        isSelf: true,
        source: MessageSource.API_SEND,
        externalRequestId: 'cake_registered_request',
        payload: { text: 'exact original' },
      });
      expect(response).toBeInstanceOf(Promise);
      expect(mockPipelineService.execute).not.toHaveBeenCalled();
      expect(replyRecords.appendCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          corpId: 'org-123',
          accountId: 'wxid-bot-123',
          chatId: 'chat-123',
          requestId: 'cake_registered_request',
          text: 'exact original',
          messageType: MessageType.TEXT,
        }),
      );
      release(true);
      await expect(response).resolves.toEqual({ success: true, message: 'Message received' });
      await flushAsync();
    });

    it('does not acknowledge a managed callback when evidence persistence is uncertain', async () => {
      replyRecords.appendCallback.mockRejectedValue(new Error('evidence write timeout'));
      await expect(
        service.handleMessage({
          ...validMessageData,
          isSelf: true,
          source: MessageSource.API_SEND,
          externalRequestId: 'cake_registered_request',
        }),
      ).rejects.toThrow('evidence write timeout');
      expect(mockPipelineService.execute).not.toHaveBeenCalled();
      expect(mockSimpleMergeService.addMessage).not.toHaveBeenCalled();
    });

    beforeEach(async () => {
      await service.onModuleInit();
    });

    const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

    it('always ACKs immediately with "Message received" regardless of pipeline branch', async () => {
      // 托管平台只要求 HTTP 200；此前根据 filter/dup/disabled 返回不同文案属于过度约定。
      // 统一响应后，后续写入、监控都在微任务里完成，不会再拖慢回调返回。
      mockPipelineService.execute.mockResolvedValue({
        shouldDispatch: false,
        response: { success: true, message: 'Duplicate message ignored' },
      });

      const result = service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      await flushAsync();
      expect(mockSimpleMergeService.addMessage).not.toHaveBeenCalled();
    });

    it('should mark message processed when AI reply is disabled (async side-effects)', async () => {
      mockRuntimeConfigService.isAiReplyEnabled.mockReturnValue(false);

      const result = service.handleMessage(validMessageData);
      expect(result).toEqual({ success: true, message: 'Message received' });

      // 异步处理需要经过多个 await（syncSnapshot + pipeline + observability），多次 flush 才能结算完。
      for (let i = 0; i < 10; i += 1) await flushAsync();

      expect(mockWecomObservabilityService.startRequestTrace).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: 'msg-123' }),
      );
      expect(mockMonitoringService.recordSuccess).toHaveBeenCalledWith(
        'msg-123',
        expect.objectContaining({ replyPreview: '[AI回复已禁用]' }),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should enqueue messages when merge is enabled', async () => {
      const result = service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      for (let i = 0; i < 10; i += 1) await flushAsync();
      expect(mockSimpleMergeService.addMessage).toHaveBeenCalledWith(validMessageData);
      expect(mockPipelineService.processSingleMessage).not.toHaveBeenCalled();
    });

    it('should record failure when merge enqueue fails', async () => {
      mockSimpleMergeService.addMessage.mockRejectedValue(new Error('redis down'));

      const result = service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      for (let i = 0; i < 10; i += 1) await flushAsync();
      expect(mockWecomObservabilityService.startRequestTrace).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: 'msg-123' }),
      );
      expect(mockWecomObservabilityService.updateDispatch).toHaveBeenCalledWith(
        'msg-123',
        'merged',
      );
      expect(mockWecomObservabilityService.buildFailureMetadata).toHaveBeenCalledWith(
        'msg-123',
        expect.objectContaining({ errorType: 'merge', errorMessage: 'redis down' }),
      );
      expect(mockMonitoringService.recordFailure).toHaveBeenCalledWith(
        'msg-123',
        'redis down',
        expect.anything(),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should process message immediately when merge is disabled', async () => {
      mockRuntimeConfigService.isMessageMergeEnabled.mockReturnValue(false);

      const result = service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      for (let i = 0; i < 10; i += 1) await flushAsync();
      expect(mockPipelineService.processSingleMessage).toHaveBeenCalledWith(validMessageData);
      expect(mockSimpleMergeService.addMessage).not.toHaveBeenCalled();
    });

    it('returns synchronously without waiting on pipeline/runtimeConfig awaits', async () => {
      // 关键回归：即便 pipeline.execute 永远 pending，handleMessage 也必须已返回 200。
      let pipelineResolve: (value: unknown) => void = () => undefined;
      mockPipelineService.execute.mockReturnValueOnce(
        new Promise((resolve) => {
          pipelineResolve = resolve;
        }),
      );

      const result = service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      // 清理：避免遗留的 pending Promise 拖住测试进程
      pipelineResolve({
        shouldDispatch: false,
        response: { success: true, message: 'Message received' },
      });
      await flushAsync();
    });
  });

  describe('processMergedMessages', () => {
    it('should delegate to pipeline service', async () => {
      await service.processMergedMessages([validMessageData], 'batch-001', 1);

      expect(mockPipelineService.processMergedMessages).toHaveBeenCalledWith(
        [validMessageData],
        'batch-001',
        1,
      );
    });
  });
});
