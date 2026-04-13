import { AlertLevel } from '@enums/alert.enum';
import { FEISHU_RECEIVER_USERS } from '@infra/feishu/constants/receivers';
import { AlertCardRenderer } from '@notification/renderers/alert-card.renderer';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';

describe('AlertNotifierService', () => {
  const mockAlertChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  };

  const mockCardBuilder = {
    buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
  };

  let service: AlertNotifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAlertChannel.send.mockResolvedValue(true);
    const renderer = new AlertCardRenderer(mockCardBuilder as never);
    service = new AlertNotifierService(mockAlertChannel as never, renderer);
  });

  it('should render urgent alerts with inline structured diagnostics', async () => {
    await service.sendAlert({
      errorType: 'agent',
      error: new Error('messages 为空，无法调用 LLM'),
      conversationId: 'chat-123',
      userMessage: '你好',
      contactName: 'Alice',
      fallbackMessage: '我确认下哈，马上回你~',
      scenario: 'candidate-consultation',
      level: AlertLevel.WARNING,
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
      extra: {
        errorCategory: 'retryable',
        modelsAttempted: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
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
      errorType: 'agent',
      error: new Error('所有模型均失败'),
      conversationId: 'chat-123',
      userMessage: '明天7点半~10点半',
      contactName: 'Alice',
      apiEndpoint: '/api/v1/chat',
      scenario: 'candidate-consultation',
      fallbackMessage: '我这边查一下，稍等~',
      level: AlertLevel.WARNING,
      extra: {
        modelsAttempted: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
        errorCategory: 'rate_limited',
        totalAttempts: 2,
        messageCount: 8,
        batchId: 'batch-123',
        dispatchMode: 'merged',
        sessionId: 'chat-123',
        unknownField: 'bar',
      },
    });

    const payload = mockCardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.content).toContain('**模型链**: anthropic/claude-sonnet-4 -> openai/gpt-4o');
    expect(payload.content).toContain('**错误分类**: rate_limited');
    expect(payload.content).toContain('**批次 ID**: batch-123');
    expect(payload.content).toContain('**调度模式**: merged');
    expect(payload.content).toContain('"unknownField": "bar"');
    expect(payload.content.match(/\*\*会话 ID\*\*/g)).toHaveLength(1);
    expect(payload.content).not.toContain('**额外信息**');
  });

  it('should throttle repeated alerts within the configured window', async () => {
    const context = {
      errorType: 'agent' as const,
      scenario: 'candidate-consultation',
      title: '模型失败',
      message: '所有模型都挂了',
      level: AlertLevel.ERROR,
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
      errorType: 'system',
      scenario: 'cron:data-cleanup',
      title: '发送失败',
      message: 'cleanup failed',
      level: AlertLevel.ERROR,
    });

    expect(success).toBe(false);
  });

  it('should not duplicate manual intervention wording when title already contains it', async () => {
    await service.sendAlert({
      errorType: 'agent_fallback',
      title: '需要人工介入',
      error: new Error('fallback'),
      scenario: 'candidate-consultation',
      level: AlertLevel.WARNING,
      atAll: true,
    });

    const payload = mockCardBuilder.buildMarkdownCard.mock.calls[0][0];
    expect(payload.title).toBe('需要人工介入');
  });
});
