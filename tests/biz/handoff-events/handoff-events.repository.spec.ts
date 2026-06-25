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
        idempotency_key: 'trace-1',
        created_at: '2026-06-05T03:00:00.000Z',
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
});
