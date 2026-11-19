import { HandoffEventsRepository } from '@biz/handoff-events/handoff-events.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

describe('HandoffEventsRepository', () => {
  const repository = new HandoffEventsRepository({
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn().mockReturnValue(true),
  } as unknown as SupabaseService);

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  type ChainMock = Record<string, jest.Mock> & Promise<{ data: unknown; error: unknown }>;
  function chain(result: { data: unknown; error: unknown }): ChainMock {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mock: any = Object.assign(Promise.resolve(result), {});
    for (const m of ['upsert', 'update', 'delete', 'select', 'eq', 'is', 'lt']) {
      mock[m] = jest.fn().mockReturnValue(mock);
    }
    return mock as ChainMock;
  }
  function mockClientWithRpc(table: ChainMock, rpcResult: { data: unknown; error: unknown }) {
    const rpc = jest.fn().mockResolvedValue(rpcResult);
    const from = jest.fn().mockReturnValue(table);
    jest
      .spyOn(repository as unknown as { getClient(): unknown }, 'getClient')
      .mockReturnValue({ from, rpc });
    return { from, rpc };
  }

  const input = {
    corpId: 'corp',
    chatId: 'chat',
    reasonCode: 'other',
    idempotencyKey: 'k',
    occurredAt: new Date('2026-06-05T03:00:00Z'),
  };
  it.each([
    ['inserted', 'inserted'],
    ['duplicate', 'duplicate'],
    ['scope_conflict', 'duplicate'],
    [null, 'failed'],
  ])('preserves the atomic result %p', async (data, outcome) => {
    const table = chain({ data: null, error: null });
    const { rpc, from } = mockClientWithRpc(table, { data, error: null });
    await expect(repository.insertHandoffEvent(input)).resolves.toBe(outcome);
    expect(rpc).toHaveBeenCalledWith('record_handoff', {
      p_ticket: expect.objectContaining({
        corp_id: 'corp',
        chat_id: 'chat',
        created_at: input.occurredAt.toISOString(),
        reason: null,
        job_id: null,
        missing_job_info: null,
        idempotency_key: 'k',
      }),
      p_origin: 'agent_tool',
      p_manager: null,
      p_group: null,
    });
    expect(from).not.toHaveBeenCalled();
  });
  it('resolves only the persisted pause scope through the RPC', async () => {
    const { rpc } = mockClientWithRpc(chain({ data: null, error: null }), { data: 2, error: null });
    expect(await repository.markResolvedByChat('chat', 'resumed')).toBe(2);
    expect(rpc).toHaveBeenCalledWith('resolve_hosting_handoffs', {
      p_user: 'chat',
      p_outcome: 'resumed',
    });
  });
  it('deletes rows older than the retention cutoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    try {
      const table = chain({ data: [{ id: 1 }], error: null });
      mockClientWithRpc(table, { data: null, error: null });

      const deleted = await repository.cleanupExpiredEvents(90);

      expect(deleted).toBe(1);
      expect(table.delete).toHaveBeenCalled();
      expect(table.lt).toHaveBeenCalledWith('created_at', '2026-06-04T00:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });
});
