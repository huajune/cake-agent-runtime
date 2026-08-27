import { AgentExecutionEventRepository } from '@biz/monitoring/repositories/agent-execution-event.repository';
import type { SupabaseService } from '@infra/supabase/supabase.service';

describe('AgentExecutionEventRepository', () => {
  const selectMock = jest.fn();
  const querySelectMock = jest.fn();
  const eqMock = jest.fn();
  const orderMock = jest.fn();
  const limitMock = jest.fn();
  const insertMock = jest.fn();
  const fromMock = jest.fn();
  const rpcMock = jest.fn();
  const supabaseService = {
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn(),
  };

  let repository: AgentExecutionEventRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    insertMock.mockReturnValue({ select: selectMock });
    fromMock.mockReturnValue({ insert: insertMock, select: querySelectMock });
    supabaseService.getSupabaseClient.mockReturnValue({ from: fromMock, rpc: rpcMock });
    supabaseService.isClientInitialized.mockReturnValue(true);
    selectMock.mockResolvedValue({
      data: [{ id: 1 }],
      error: null,
    });
    querySelectMock.mockReturnValue({ eq: eqMock });
    eqMock.mockReturnValue({ order: orderMock });
    orderMock.mockReturnValue({ limit: limitMock });
    limitMock.mockResolvedValue({ data: [], error: null });
    rpcMock.mockResolvedValue({
      data: [{ deleted_count: '7' }],
      error: null,
    });
    repository = new AgentExecutionEventRepository(supabaseService as never as SupabaseService);
  });

  it('maps and inserts an AgentExecutionEvent into agent_execution_events', async () => {
    await repository.saveEvent({
      type: 'tool_call',
      traceId: 'trace-1',
      chatId: 'chat-1',
      userId: 'user-1',
      corpId: 'corp-1',
      scenario: 'recruiting',
      callerKind: 'wecom',
      timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
      toolName: 'duliday_job_list',
      status: 'empty',
      durationMs: 456,
      resultCount: 0,
    });

    expect(fromMock).toHaveBeenCalledWith('agent_execution_events');
    expect(insertMock).toHaveBeenCalledWith({
      trace_id: 'trace-1',
      event_type: 'tool_call',
      user_id: 'user-1',
      corp_id: 'corp-1',
      chat_id: 'chat-1',
      scenario: 'recruiting',
      caller_kind: 'wecom',
      payload: {
        toolName: 'duliday_job_list',
        status: 'empty',
        durationMs: 456,
        resultCount: 0,
      },
      created_at: '2026-01-02T03:04:05.000Z',
    });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('skips saveEvent when Supabase is unavailable', async () => {
    supabaseService.isClientInitialized.mockReturnValue(false);

    await repository.saveEvent({ type: 'agent_end', durationMs: 12 });

    expect(fromMock).not.toHaveBeenCalled();
  });

  it('finds up to 200 events by trace ID in chronological order', async () => {
    limitMock.mockResolvedValueOnce({
      data: [
        {
          id: 11,
          trace_id: 'trace-1',
          event_type: 'tool_call',
          user_id: 'user-1',
          corp_id: null,
          chat_id: 'chat-1',
          scenario: 'recruiting',
          caller_kind: 'wecom',
          payload: { toolName: 'duliday_job_list', status: 'empty' },
          created_at: '2026-08-24T01:02:03.000Z',
        },
      ],
      error: null,
    });

    await expect(repository.findByTraceId('trace-1')).resolves.toEqual([
      {
        id: 11,
        type: 'tool_call',
        traceId: 'trace-1',
        userId: 'user-1',
        corpId: undefined,
        chatId: 'chat-1',
        scenario: 'recruiting',
        callerKind: 'wecom',
        payload: { toolName: 'duliday_job_list', status: 'empty' },
        createdAt: '2026-08-24T01:02:03.000Z',
      },
    ]);
    expect(fromMock).toHaveBeenCalledWith('agent_execution_events');
    expect(querySelectMock).toHaveBeenCalledWith('*');
    expect(eqMock).toHaveBeenCalledWith('trace_id', 'trace-1');
    expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(limitMock).toHaveBeenCalledWith(200);
  });

  it('throws when insert returns no row', async () => {
    selectMock.mockResolvedValueOnce({ data: [], error: null });

    await expect(repository.saveEvent({ type: 'agent_end', durationMs: 12 })).rejects.toThrow(
      'agent_execution_events insert returned no row',
    );
  });

  it('cleans up expired events through the retention RPC', async () => {
    await expect(repository.cleanupExpiredEvents(60)).resolves.toBe(7);

    expect(rpcMock).toHaveBeenCalledWith('cleanup_agent_execution_events', { days_to_keep: 60 });
  });

  it('returns zero cleanup count when Supabase is unavailable', async () => {
    supabaseService.isClientInitialized.mockReturnValue(false);

    await expect(repository.cleanupExpiredEvents(60)).resolves.toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
