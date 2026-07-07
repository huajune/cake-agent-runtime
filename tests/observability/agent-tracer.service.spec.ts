import { AgentTracerService } from '@observability/agent-tracer.service';
import type { Observer } from '@observability/observer.interface';
import type { RequestContextService } from '@observability/context/request-context.service';

describe('AgentTracerService', () => {
  const requestContext = {
    get: jest.fn(),
  };
  const observer: jest.Mocked<Observer> = {
    emit: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    requestContext.get.mockReturnValue({
      traceId: 'trace-1',
      chatId: 'chat-1',
      userId: 'ctx-user',
      scenario: 'ctx-scenario',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enriches events with request context and a fresh timestamp', () => {
    const service = new AgentTracerService(requestContext as never, observer);

    service.emit({
      type: 'tool_call',
      toolName: 'duliday_job_list',
      userId: 'event-user',
      status: 'ok',
    });

    expect(observer.emit).toHaveBeenCalledWith({
      traceId: 'trace-1',
      chatId: 'chat-1',
      userId: 'event-user',
      scenario: 'ctx-scenario',
      timestamp: 1_700_000_000_000,
      type: 'tool_call',
      toolName: 'duliday_job_list',
      status: 'ok',
    });
  });

  it('does nothing when no observer is registered', () => {
    const service = new AgentTracerService(requestContext as never as RequestContextService);

    expect(() =>
      service.emit({ type: 'model_call', modelId: 'gpt-5', role: 'primary' }),
    ).not.toThrow();
    expect(requestContext.get).not.toHaveBeenCalled();
  });

  it('swallows observer dispatch errors', () => {
    observer.emit.mockImplementationOnce(() => {
      throw new Error('observer down');
    });
    const service = new AgentTracerService(requestContext as never, observer);

    expect(() => service.emit({ type: 'agent_error', error: 'boom' })).not.toThrow();
  });
});
