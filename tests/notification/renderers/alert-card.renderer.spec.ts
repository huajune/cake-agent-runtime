import { AlertLevel } from '@enums/alert.enum';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { AlertCardRenderer } from '@notification/renderers/alert-card.renderer';

describe('AlertCardRenderer', () => {
  let renderer: AlertCardRenderer;
  let cardBuilder: jest.Mocked<FeishuCardBuilderService>;

  beforeEach(() => {
    cardBuilder = {
      buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
    } as unknown as jest.Mocked<FeishuCardBuilderService>;

    renderer = new AlertCardRenderer(cardBuilder);
  });

  it('should decorate manual intervention alerts and render inline diagnostics', () => {
    renderer.buildAlertCard({
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
        managerName: '招募经理A',
        scenario: 'candidate-consultation',
      },
      impact: {
        userMessage: '你好，我想找兼职',
        fallbackMessage: '我确认下哈，马上回你~',
        deliveryState: 'none',
        requiresHumanIntervention: true,
      },
      routing: {
        atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      },
      diagnostics: {
        error: new Error('所有模型均失败'),
        category: 'retryable',
        modelChain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
        totalAttempts: 2,
        memoryWarning: 'shortTerm timeout',
        dispatchMode: 'merged',
        messageCount: 3,
      },
    });

    const payload = cardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.title).toBe('🚨 Agent 调用异常 · 需要人工介入');
    expect(payload.color).toBe('red');
    expect(payload.atUsers).toEqual([FEISHU_RECEIVER_USERS.GAO_YAQI]);
    expect(payload.content).toContain('**微信昵称**: Alice');
    expect(payload.content).toContain('**托管账号**: 招募经理A');
    expect(payload.content).toContain('**用户消息**: 你好，我想找兼职');
    expect(payload.content).toContain('**蛋糕已回复（降级）**: 我确认下哈，马上回你~');
    expect(payload.content).toContain('**异常消息**: 所有模型均失败');
    expect(payload.content).toContain('**会话 ID**: chat-123');
    expect(payload.content).toContain('**来源**: wecom/MessagePipelineService.handleProcessingFailure [http]');
    expect(payload.content).toContain('**投递状态**: none');
    expect(payload.content).toContain('📎 错误分类: retryable');
    expect(payload.content).toContain('模型链: anthropic/claude-sonnet-4 -> openai/gpt-4o');
    expect(payload.content).toContain('重试次数: 2');
    expect(payload.content).toContain('记忆告警: shortTerm timeout');
    expect(payload.content).toContain('调度模式: merged');
    expect(payload.content).toContain('消息条数: 3');
  });

  it('should render structured extras, details, and omit duplicate session id', () => {
    renderer.buildAlertCard({
      code: 'system.exception',
      source: {
        subsystem: 'observability',
        component: 'ProcessExceptionMonitorService',
        action: 'uncaughtException',
        trigger: 'process',
      },
      scope: {
        chatId: 'chat-456',
        sessionId: 'chat-456',
        batchId: 'batch-123',
        scenario: 'process:uncaughtException',
      },
      severity: AlertLevel.CRITICAL,
      diagnostics: {
        error: {
          response: {
            data: {
              details: 'gateway timeout',
            },
            status: 504,
          },
        },
        errorName: 'Error',
        stack: 'line1\nline2',
        payload: {
          apiKey: 'sk-***',
          unknownField: 'leftover',
        },
      },
      occurredAt: '2026/04/13 14:52:00',
    });

    const payload = cardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.title).toBe('🚨 系统异常');
    expect(payload.color).toBe('red');
    expect(payload.content).toContain('**时间**: 2026/04/13 14:52:00');
    expect(payload.content).toContain('**级别**: CRITICAL');
    expect(payload.content).toContain('**告警码**: system.exception');
    expect(payload.content).toContain(
      '**来源**: observability/ProcessExceptionMonitorService.uncaughtException [process]',
    );
    expect(payload.content).toContain('**异常消息**: gateway timeout (HTTP 504)');
    expect(payload.content).toContain('**会话 ID**: chat-456');
    expect(payload.content).toContain('**场景**: process:uncaughtException');
    expect(payload.content).toContain('**批次 ID**: batch-123');
    expect(payload.content).toContain('**错误名称**: Error');
    expect(payload.content).toContain('**堆栈**:');
    expect(payload.content).toContain('"apiKey": "sk-***"');
    expect(payload.content).toContain('"unknownField": "leftover"');
    expect((payload.content as string).match(/\*\*会话 ID\*\*/g)).toHaveLength(1);
  });

  it('should expose helper constructors for fallback and prompt injection alerts', () => {
    expect(
      renderer.createFallbackMentionAlert({
        code: 'agent.fallback_required',
        summary: '需要人工介入',
        source: {
          subsystem: 'wecom',
          component: 'MessagePipelineService',
          action: 'sendFallbackAlert',
          trigger: 'http',
        },
        impact: {
          deliveryState: 'fallback_sent',
        },
      }),
    ).toEqual({
      code: 'agent.fallback_required',
      summary: '需要人工介入',
      source: {
        subsystem: 'wecom',
        component: 'MessagePipelineService',
        action: 'sendFallbackAlert',
        trigger: 'http',
      },
      impact: {
        deliveryState: 'fallback_sent',
        requiresHumanIntervention: true,
      },
      routing: {
        atAll: true,
      },
    });

    const promptAlert = renderer.createPromptInjectionAlert({
      userId: 'user-1',
      reason: 'contains jailbreak',
      contentPreview: 'x'.repeat(260),
    });

    expect(promptAlert.code).toBe('security.prompt_injection_detected');
    expect(promptAlert.summary).toBe('Prompt Injection 告警');
    expect(promptAlert.severity).toBe(AlertLevel.WARNING);
    expect(promptAlert.source).toEqual({
      subsystem: 'security',
      component: 'InputGuardService',
      action: 'alertInjection',
      trigger: 'http',
    });
    expect(promptAlert.scope).toEqual({
      userId: 'user-1',
      scenario: 'security',
    });
    expect(promptAlert.diagnostics?.error).toBeInstanceOf(Error);
    expect((promptAlert.diagnostics?.error as Error).message).toBe(
      'Prompt injection: contains jailbreak',
    );
    expect(promptAlert.diagnostics?.payload).toEqual({
      reason: 'contains jailbreak',
      contentPreview: 'x'.repeat(200),
    });
    expect(promptAlert.dedupe).toEqual({
      key: 'security.prompt_injection_detected:user-1',
    });
    expect(renderer.createGroupFullMentionUsers()).toEqual([FEISHU_RECEIVER_USERS.GAO_YAQI]);
  });
});
