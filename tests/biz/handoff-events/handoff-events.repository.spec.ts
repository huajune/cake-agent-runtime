import { HandoffEventsRepository } from '@biz/handoff-events/handoff-events.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

type UpsertOptions = { onConflict?: string; ignoreDuplicates?: boolean };
type RepositoryWithUpsert = HandoffEventsRepository & {
  upsert<T>(data: Partial<T>, options?: UpsertOptions): Promise<T | null>;
};

describe('HandoffEventsRepository', () => {
  const repository = new HandoffEventsRepository({
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn().mockReturnValue(true),
  } as unknown as SupabaseService);

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('upserts handoff_events with the expected idempotency key and nullable fields', async () => {
    const upsertSpy = jest
      .spyOn(repository as RepositoryWithUpsert, 'upsert')
      .mockResolvedValue({ idempotency_key: 'trace-1' });
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

    expect(inserted).toBe(true);
    expect(upsertSpy).toHaveBeenCalledWith(
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

  it('returns false when the idempotent upsert is skipped or unavailable', async () => {
    jest.spyOn(repository as RepositoryWithUpsert, 'upsert').mockResolvedValue(null);

    await expect(
      repository.insertHandoffEvent({
        corpId: 'corp-1',
        chatId: 'chat-1',
        reasonCode: 'other',
        idempotencyKey: 'trace-1',
        occurredAt: new Date('2026-06-05T03:00:00.000Z'),
      }),
    ).resolves.toBe(false);
  });
});
