import { Environment } from '@enums/environment.enum';
import { AlertLevel } from '@enums/alert.enum';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { AlertCardRenderer } from '@notification/renderers/alert-card.renderer';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { AlertContext } from '@notification/types/alert.types';

describe('AlertNotifierService', () => {
  const mockAlertChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  };

  const mockCardBuilder = {
    buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
  };
  const mockConfigService = {
    get: jest.fn(),
  };
  const mockPersister = {
    persist: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined),
  };
  const mockModuleRef = {
    get: jest.fn().mockImplementation(() => mockPersister),
  };

  let service: AlertNotifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAlertChannel.send.mockResolvedValue(true);
    mockPersister.persist.mockResolvedValue(undefined);
    mockConfigService.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'NODE_ENV') return Environment.Production;
      return defaultValue;
    });
    const renderer = new AlertCardRenderer(mockCardBuilder as never);
    service = new AlertNotifierService(
      mockAlertChannel as never,
      renderer,
      mockModuleRef as never,
      mockConfigService as never,
    );
    service.onApplicationBootstrap();
  });

  it('should render urgent alerts with inline structured diagnostics', async () => {
    await service.sendAlert({
      code: 'agent.invoke_failed',
      severity: AlertLevel.WARNING,
      source: {
        subsystem: 'wecom',
        component: 'MessagePipelineService',
        action: 'handleProcessingFailure',
        trigger: 'http',
      },
      scope: {
        chatId: 'chat-123',
        contactName: 'Alice',
        scenario: 'candidate-consultation',
      },
      impact: {
        userMessage: '你好',
        fallbackMessage: '我确认下哈，马上回你~',
        requiresHumanIntervention: true,
      },
      routing: {
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      },
      diagnostics: {
        error: new Error('messages 为空，无法调用 LLM'),
        category: 'retryable',
        modelChain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
        totalAttempts: 2,
        memoryWarning: 'shortTerm: Connection timeout',
        dispatchMode: 'merged',
      },
    });

    const payload = mockCardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.title).toContain('人工介入');
    expect(payload.content).toContain('**会话 ID**: chat-123');
    expect(payload.content).toContain(
      '📎 错误分类: retryable | 模型链: anthropic/claude-sonnet-4 -> openai/gpt-4o | 重试次数: 2 | 记忆告警: shortTerm: Connection timeout | 调度模式: merged',
    );
  });

  it('should render known extra fields structurally and keep unknown fields in JSON', async () => {
    await service.sendAlert({
      code: 'agent.invoke_failed',
      severity: AlertLevel.WARNING,
      source: {
        subsystem: 'wecom',
        component: 'MessagePipelineService',
        action: 'handleProcessingFailure',
        trigger: 'http',
      },
      scope: {
        chatId: 'chat-123',
        sessionId: 'chat-123',
        batchId: 'batch-123',
        contactName: 'Alice',
        scenario: 'candidate-consultation',
      },
      impact: {
        userMessage: '明天7点半~10点半',
        fallbackMessage: '我这边查一下，稍等~',
      },
      diagnostics: {
        error: new Error('所有模型均失败'),
        modelChain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
        category: 'rate_limited',
        totalAttempts: 2,
        messageCount: 8,
        dispatchMode: 'merged',
        payload: {
          unknownField: 'bar',
        },
      },
    });

    const payload = mockCardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.content).toContain('**模型链**: anthropic/claude-sonnet-4 -> openai/gpt-4o');
    expect(payload.content).toContain('**错误分类**: rate_limited');
    expect(payload.content).toContain('**批次 ID**: batch-123');
    expect(payload.content).toContain('**调度模式**: merged');
    expect(payload.content).toContain('"unknownField": "bar"');
    expect(payload.content.match(/\*\*会话 ID\*\*/g)).toHaveLength(1);
    expect(payload.content).not.toContain('**其他**');
  });

  it('should throttle repeated alerts within the configured window', async () => {
    const context: AlertContext = {
      code: 'agent.invoke_failed',
      summary: '模型失败',
      severity: AlertLevel.ERROR,
      source: {
        subsystem: 'wecom',
        component: 'MessagePipelineService',
        action: 'handleProcessingFailure',
        trigger: 'http',
      },
      scope: {
        scenario: 'candidate-consultation',
      },
      diagnostics: {
        errorMessage: '所有模型都挂了',
      },
      dedupe: {
        key: 'agent.invoke_failed:candidate-consultation',
      },
    };

    await service.sendAlert(context);
    await service.sendAlert(context);
    await service.sendAlert(context);
    const fourth = await service.sendAlert(context);

    expect(fourth).toBe(false);
    expect(mockAlertChannel.send).toHaveBeenCalledTimes(3);
  });

  it('should return false when channel throws', async () => {
    mockAlertChannel.send.mockRejectedValueOnce(new Error('network boom'));

    const success = await service.sendAlert({
      code: 'system.exception',
      summary: '发送失败',
      severity: AlertLevel.ERROR,
      source: {
        subsystem: 'monitoring',
        component: 'DataCleanupService',
        action: 'cleanup',
        trigger: 'cron',
      },
      scope: {
        scenario: 'cron:data-cleanup',
      },
      diagnostics: {
        errorMessage: 'cleanup failed',
      },
    });

    expect(success).toBe(false);
  });

  it('should not duplicate manual intervention wording when title already contains it', async () => {
    await service.sendAlert({
      code: 'agent.fallback_required',
      summary: '需要人工介入',
      severity: AlertLevel.WARNING,
      source: {
        subsystem: 'wecom',
        component: 'MessagePipelineService',
        action: 'sendFallbackAlert',
        trigger: 'http',
      },
      scope: {
        scenario: 'candidate-consultation',
      },
      impact: {
        requiresHumanIntervention: true,
      },
      diagnostics: {
        error: new Error('fallback'),
      },
      routing: {
        atAll: true,
      },
    });

    const payload = mockCardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.title).toBe('🚨 需要人工介入');
  });

  describe('alert log persistence (告警持久化统一)', () => {
    const subsystemAlert: AlertContext = {
      code: 'group_task.preview_failed',
      summary: '群任务飞书预览发送失败',
      severity: AlertLevel.ERROR,
      source: {
        subsystem: 'group-task',
        component: 'NotificationSenderService',
        action: 'sendPreview',
        trigger: 'cron',
      },
      diagnostics: { errorMessage: 'feishu 5xx' },
      dedupe: { key: 'group_task.preview_failed' },
    };

    it('persists on successful delivery (throttled=false, delivered=true)', async () => {
      await service.sendAlert(subsystemAlert);
      expect(mockPersister.persist).toHaveBeenCalledTimes(1);
      expect(mockPersister.persist).toHaveBeenCalledWith(
        expect.objectContaining({
          subsystem: 'group-task',
          code: 'group_task.preview_failed',
          throttled: false,
          delivered: true,
        }),
      );
    });

    it('persists throttled alerts too (throttled=true, delivered=false)', async () => {
      await service.sendAlert(subsystemAlert);
      await service.sendAlert(subsystemAlert);
      await service.sendAlert(subsystemAlert);
      mockPersister.persist.mockClear();
      await service.sendAlert(subsystemAlert); // 第 4 次被节流

      expect(mockPersister.persist).toHaveBeenCalledTimes(1);
      expect(mockPersister.persist).toHaveBeenCalledWith(
        expect.objectContaining({ throttled: true, delivered: false }),
      );
    });

    it('persists even when channel throws (delivered=false)', async () => {
      mockAlertChannel.send.mockRejectedValueOnce(new Error('network boom'));
      await service.sendAlert(subsystemAlert);
      expect(mockPersister.persist).toHaveBeenCalledWith(
        expect.objectContaining({ delivered: false }),
      );
    });

    it('persists in non-production even when Feishu delivery is suppressed', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: unknown) => {
        if (key === 'NODE_ENV') return Environment.Development;
        return defaultValue;
      });
      await service.sendAlert(subsystemAlert);
      expect(mockAlertChannel.send).not.toHaveBeenCalled();
      expect(mockPersister.persist).toHaveBeenCalledWith(
        expect.objectContaining({ delivered: false }),
      );
    });

    it('does NOT persist when options.persist=false (消息失败路径已 recordFailure 落库)', async () => {
      await service.sendAlert(subsystemAlert, { persist: false });
      expect(mockPersister.persist).not.toHaveBeenCalled();
      // 但飞书仍正常发送
      expect(mockAlertChannel.send).toHaveBeenCalledTimes(1);
    });

    it('degrades gracefully when ALERT_LOG_PERSISTER is not registered (ModuleRef 懒解析失败)', async () => {
      mockModuleRef.get.mockImplementation(() => {
        throw new Error('No provider for ALERT_LOG_PERSISTER');
      });
      const renderer = new AlertCardRenderer(mockCardBuilder as never);
      const degraded = new AlertNotifierService(
        mockAlertChannel as never,
        renderer,
        mockModuleRef as never,
        mockConfigService as never,
      );
      degraded.onApplicationBootstrap();

      const delivered = await degraded.sendAlert(subsystemAlert);
      expect(delivered).toBe(true);
      expect(mockPersister.persist).not.toHaveBeenCalled();
    });
  });

  it('should suppress Feishu delivery in non-production by default', async () => {
    mockConfigService.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'NODE_ENV') return Environment.Development;
      return defaultValue;
    });

    const success = await service.sendAlert({
      code: 'system.exception',
      summary: '开发环境异常',
      severity: AlertLevel.ERROR,
      source: {
        subsystem: 'monitoring',
        component: 'AnalyticsMaintenanceService',
        action: 'aggregateHourlyStats',
        trigger: 'startup',
      },
      diagnostics: {
        errorMessage: 'dev only',
      },
    });

    expect(success).toBe(false);
    expect(mockAlertChannel.send).not.toHaveBeenCalled();
  });

  it('should allow Feishu delivery in non-production when explicitly enabled', async () => {
    mockConfigService.get.mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'NODE_ENV') return Environment.Development;
      if (key === 'FEISHU_ALERT_ALLOW_NON_PROD') return 'true';
      return defaultValue;
    });

    const success = await service.sendAlert({
      code: 'system.exception',
      summary: '开发环境异常',
      severity: AlertLevel.ERROR,
      source: {
        subsystem: 'monitoring',
        component: 'AnalyticsMaintenanceService',
        action: 'aggregateHourlyStats',
        trigger: 'startup',
      },
      diagnostics: {
        errorMessage: 'dev only',
      },
    });

    expect(success).toBe(true);
    expect(mockAlertChannel.send).toHaveBeenCalledTimes(1);
  });
});
