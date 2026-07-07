import { AgentExecutionEventPersisterService } from '@biz/monitoring/services/tracking/agent-execution-event.persister';
import { AlertLevel } from '@enums/alert.enum';

describe('AgentExecutionEventPersisterService', () => {
  const repository = {
    saveEvent: jest.fn(),
  };
  const alertNotifier = {
    sendAlert: jest.fn(),
  };

  let service: AgentExecutionEventPersisterService;

  beforeEach(() => {
    jest.clearAllMocks();
    repository.saveEvent.mockResolvedValue(undefined);
    alertNotifier.sendAlert.mockResolvedValue(undefined);
    service = new AgentExecutionEventPersisterService(repository as never, alertNotifier as never);
  });

  it('persists events through the repository', async () => {
    const event = { type: 'agent_end', traceId: 'trace-1', durationMs: 123 } as const;

    await service.persist(event);

    expect(repository.saveEvent).toHaveBeenCalledWith(event);
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('swallows repository failures and sends an alert with trace context', async () => {
    const error = new Error('insert failed');
    repository.saveEvent.mockRejectedValueOnce(error);

    await expect(
      service.persist({
        type: 'tool_error',
        traceId: 'trace-1',
        chatId: 'chat-1',
        userId: 'user-1',
        scenario: 'recruiting',
        callerKind: 'wecom',
        toolName: 'geocode',
        error: 'timeout',
      }),
    ).resolves.toBeUndefined();

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith({
      code: 'agent_execution_event_persist_failed',
      severity: AlertLevel.ERROR,
      summary: 'Agent 执行事件落库失败，该 trace 的执行下钻信息可能不完整',
      source: {
        subsystem: 'agent',
        component: 'observability',
        action: 'persist_execution_event',
      },
      scope: {
        messageId: 'trace-1',
        chatId: 'chat-1',
        userId: 'user-1',
      },
      diagnostics: {
        error,
        payload: {
          eventType: 'tool_error',
          scenario: 'recruiting',
          callerKind: 'wecom',
        },
      },
      dedupe: { key: 'agent_execution_event_persist_failed:tool_error' },
    });
  });

  it('swallows alert delivery failures after a persist failure', async () => {
    repository.saveEvent.mockRejectedValueOnce(new Error('insert failed'));
    alertNotifier.sendAlert.mockRejectedValueOnce(new Error('alert failed'));

    await expect(service.persist({ type: 'agent_end', durationMs: 123 })).resolves.toBeUndefined();
    await Promise.resolve();
  });
});
