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
      errorType: 'agent',
      error: new Error('所有模型均失败'),
      conversationId: 'chat-123',
      userMessage: '你好，我想找兼职',
      contactName: 'Alice',
      fallbackMessage: '我确认下哈，马上回你~',
      scenario: 'candidate-consultation',
      level: AlertLevel.WARNING,
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      extra: {
        errorCategory: 'retryable',
        modelsAttempted: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
        totalAttempts: 2,
        memoryWarning: 'shortTerm timeout',
        dispatchMode: 'merged',
        messageCount: 3,
      },
    });

    const payload = cardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.title).toBe('【需人工介入】Agent 调用异常');
    expect(payload.color).toBe('yellow');
    expect(payload.atUsers).toEqual([FEISHU_RECEIVER_USERS.GAO_YAQI]);
    expect(payload.content).toContain('**用户昵称**: Alice');
    expect(payload.content).toContain('**用户消息**: 你好，我想找兼职');
    expect(payload.content).toContain('**蛋糕已回复**: 我确认下哈，马上回你~');
    expect(payload.content).toContain('**Agent 报错**: 所有模型均失败');
    expect(payload.content).toContain('**会话 ID**: chat-123');
    expect(payload.content).toContain('📎 错误分类: retryable');
    expect(payload.content).toContain('模型链: anthropic/claude-sonnet-4 -> openai/gpt-4o');
    expect(payload.content).toContain('重试次数: 2');
    expect(payload.content).toContain('记忆告警: shortTerm timeout');
    expect(payload.content).toContain('调度模式: merged');
    expect(payload.content).toContain('消息条数: 3');
  });

  it('should render structured extras, details, and omit duplicate session id', () => {
    renderer.buildAlertCard({
      errorType: 'system_exception',
      error: {
        response: {
          data: {
            details: 'gateway timeout',
          },
          status: 504,
        },
      },
      conversationId: 'chat-456',
      apiEndpoint: '/api/v1/chat',
      scenario: 'process:uncaughtException',
      level: AlertLevel.CRITICAL,
      details: { name: 'Error', stack: 'line1\nline2' },
      extra: {
        sessionId: 'chat-456',
        batchId: 'batch-123',
        apiKey: 'sk-***',
        unknownField: 'leftover',
      },
      timestamp: '2026/04/13 14:52:00',
    });

    const payload = cardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.title).toBe('系统异常');
    expect(payload.color).toBe('red');
    expect(payload.content).toContain('**时间**: 2026/04/13 14:52:00');
    expect(payload.content).toContain('**级别**: CRITICAL');
    expect(payload.content).toContain('**类型**: system_exception');
    expect(payload.content).toContain('**消息**: gateway timeout (HTTP 504)');
    expect(payload.content).toContain('**会话 ID**: chat-456');
    expect(payload.content).toContain('**API 端点**: /api/v1/chat');
    expect(payload.content).toContain('**场景**: process:uncaughtException');
    expect(payload.content).toContain('**详情**:');
    expect(payload.content).toContain('**批次 ID**: batch-123');
    expect(payload.content).toContain('**API Key**: sk-***');
    expect(payload.content).toContain('"unknownField": "leftover"');
    expect((payload.content as string).match(/\*\*会话 ID\*\*/g)).toHaveLength(1);
  });

  it('should expose helper constructors for fallback and prompt injection alerts', () => {
    expect(
      renderer.createFallbackMentionAlert({
        errorType: 'agent_fallback',
        title: '需要人工介入',
      }),
    ).toEqual({
      errorType: 'agent_fallback',
      title: '需要人工介入',
      atAll: true,
    });

    const promptAlert = renderer.createPromptInjectionAlert({
      userId: 'user-1',
      reason: 'contains jailbreak',
      contentPreview: 'x'.repeat(260),
    });

    expect(promptAlert.errorType).toBe('prompt_injection');
    expect(promptAlert.error).toBeInstanceOf(Error);
    expect((promptAlert.error as Error).message).toBe('Prompt injection: contains jailbreak');
    expect(promptAlert.apiEndpoint).toBe('agent/invoke');
    expect(promptAlert.scenario).toBe('security');
    expect(promptAlert.extra).toEqual({
      userId: 'user-1',
      reason: 'contains jailbreak',
      contentPreview: 'x'.repeat(200),
    });
    expect(renderer.createGroupFullMentionUsers()).toEqual([FEISHU_RECEIVER_USERS.GAO_YAQI]);
  });
});
