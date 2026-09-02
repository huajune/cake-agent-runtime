import { HandoffEventsRepository } from '@biz/handoff-events/handoff-events.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

type UpsertOptions = { onConflict?: string; ignoreDuplicates?: boolean };
type SelectMock = jest.Mock<Promise<{ data: unknown[] | null; error: unknown }>, [string]>;
type UpsertMock = jest.Mock<{ select: SelectMock }, [Record<string, unknown>, UpsertOptions]>;
type ClientMock = {
  from: jest.Mock<{ upsert: UpsertMock }, [string]>;
};
type RepositoryWithClient = HandoffEventsRepository & {
  getClient(): ClientMock;
};

describe('HandoffEventsRepository', () => {
  const repository = new HandoffEventsRepository({
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn().mockReturnValue(true),
  } as unknown as SupabaseService);

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  function mockClient(response: { data: unknown[] | null; error: unknown }) {
    const select = jest.fn<Promise<{ data: unknown[] | null; error: unknown }>, [string]>();
    select.mockResolvedValue(response);
    const upsert = jest.fn<{ select: SelectMock }, [Record<string, unknown>, UpsertOptions]>();
    upsert.mockReturnValue({ select });
    const from = jest.fn<{ upsert: UpsertMock }, [string]>();
    from.mockReturnValue({ upsert });
    jest.spyOn(repository as RepositoryWithClient, 'getClient').mockReturnValue({ from });
    return { from, upsert, select };
  }

  it('upserts handoff_events with the expected idempotency key and nullable fields', async () => {
    const { upsert } = mockClient({ data: [{ idempotency_key: 'trace-1' }], error: null });
    const occurredAt = new Date('2026-06-05T03:00:00.000Z');

    const inserted = await repository.insertHandoffEvent({
      corpId: 'corp-1',
      chatId: 'chat-1',
      userId: 'user-1',
      reasonCode: 'modify_appointment',
      reason: '候选人要改期',
      actionAdvice: '人工确认门店是否可改',
      stage: 'booking_followup',
      botImId: 'bot-1',
      workOrderId: 12345,
      jobId: 528572,
      missingJobInfo: ['trial_period'],
      idempotencyKey: 'trace-1',
      occurredAt,
    });

    expect(inserted).toBe('inserted');
    expect(upsert).toHaveBeenCalledWith(
      {
        corp_id: 'corp-1',
        chat_id: 'chat-1',
        user_id: 'user-1',
        reason_code: 'modify_appointment',
        reason: '候选人要改期',
        action_advice: '人工确认门店是否可改',
        stage: 'booking_followup',
        bot_im_id: 'bot-1',
        work_order_id: 12345,
        job_id: 528572,
        missing_job_info: ['trial_period'],
        idempotency_key: 'trace-1',
        created_at: '2026-06-05T03:00:00.000Z',
        // 会话内序号由 next_handoff_sequence_no RPC 取；mock 无该 RPC 时为 null，不阻断写入
        sequence_no: null,
      },
      { onConflict: 'corp_id,idempotency_key', ignoreDuplicates: true },
    );
  });

  it('returns duplicate when the idempotent upsert is skipped by conflict', async () => {
    mockClient({ data: [], error: null });

    await expect(
      repository.insertHandoffEvent({
        corpId: 'corp-1',
        chatId: 'chat-1',
        reasonCode: 'other',
        idempotencyKey: 'trace-1',
        occurredAt: new Date('2026-06-05T03:00:00.000Z'),
      }),
    ).resolves.toBe('duplicate');
  });

  it('returns failed when the database write fails', async () => {
    mockClient({ data: null, error: { message: 'db unavailable' } });

    await expect(
      repository.insertHandoffEvent({
        corpId: 'corp-1',
        chatId: 'chat-1',
        reasonCode: 'other',
        idempotencyKey: 'trace-1',
        occurredAt: new Date('2026-06-05T03:00:00.000Z'),
      }),
    ).resolves.toBe('failed');
  });

  describe('sequence_no / outcome / cleanup', () => {
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

    it('stamps sequence_no from next_handoff_sequence_no on insert', async () => {
      const table = chain({ data: [{ idempotency_key: 'trace-9' }], error: null });
      const { rpc } = mockClientWithRpc(table, { data: 3, error: null });

      const inserted = await repository.insertHandoffEvent({
        corpId: 'corp-1',
        chatId: 'chat-1',
        reasonCode: 'other',
        idempotencyKey: 'trace-9',
        occurredAt: new Date('2026-09-01T03:00:00.000Z'),
      });

      expect(inserted).toBe('inserted');
      expect(rpc).toHaveBeenCalledWith('next_handoff_sequence_no', {
        p_corp_id: 'corp-1',
        p_chat_id: 'chat-1',
      });
      expect(table.upsert.mock.calls[0][0]).toMatchObject({ sequence_no: 3 });
    });

    it('falls back to a null sequence_no when the RPC fails', async () => {
      const table = chain({ data: [{ idempotency_key: 'trace-9' }], error: null });
      mockClientWithRpc(table, { data: null, error: { message: 'rpc down' } });

      await repository.insertHandoffEvent({
        corpId: 'corp-1',
        chatId: 'chat-1',
        reasonCode: 'other',
        idempotencyKey: 'trace-9',
        occurredAt: new Date('2026-09-01T03:00:00.000Z'),
      });

      expect(table.upsert.mock.calls[0][0]).toMatchObject({ sequence_no: null });
    });

    it('marks only the still-open handoffs of a chat as resolved with the given outcome', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-02T01:00:00.000Z'));
      try {
        const table = chain({ data: [{ id: 1 }, { id: 2 }], error: null });
        mockClientWithRpc(table, { data: null, error: null });

        const count = await repository.markResolvedByChat('chat-1', 'resumed');

        expect(count).toBe(2);
        expect(table.update).toHaveBeenCalledWith({
          outcome: 'resumed',
          resolved_at: '2026-09-02T01:00:00.000Z',
        });
        expect(table.eq).toHaveBeenCalledWith('chat_id', 'chat-1');
        expect(table.is).toHaveBeenCalledWith('outcome', null);
      } finally {
        jest.useRealTimers();
      }
    });

    it('returns 0 when the outcome update fails', async () => {
      const table = chain({ data: null, error: { message: 'db down' } });
      mockClientWithRpc(table, { data: null, error: null });

      await expect(repository.markResolvedByChat('chat-1', 'expired')).resolves.toBe(0);
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
});
