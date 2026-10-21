import { OpsEventsRepository } from '@biz/ops-events/repositories/ops-events.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

describe('OpsEventsRepository', () => {
  const makeRepository = (client: unknown) =>
    new OpsEventsRepository({
      getSupabaseClient: jest.fn().mockReturnValue(client),
      isClientInitialized: jest.fn().mockReturnValue(true),
    } as unknown as SupabaseService);

  function makeClient(pagesByEvent: Record<string, unknown[][]>) {
    return {
      from: jest.fn(() => {
        let eventName = '';
        const builder = {
          select: jest.fn(() => builder),
          order: jest.fn(() => builder),
          eq: jest.fn((column: string, value: string) => {
            if (column === 'event_name') eventName = value;
            return builder;
          }),
          gte: jest.fn(() => builder),
          lte: jest.fn(() => builder),
          in: jest.fn(() => builder),
          limit: jest.fn(() =>
            Promise.resolve({ data: pagesByEvent[eventName]?.[0] ?? [], error: null }),
          ),
          range: jest.fn((from: number) => {
            const pageIndex = Math.floor(from / 100);
            return Promise.resolve({
              data: pagesByEvent[eventName]?.[pageIndex] ?? [],
              error: null,
            });
          }),
        };
        return builder;
      }),
    };
  }

  it('reads one bounded booking page and only the matching pass keys, then advances its cursor', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      corp_id: 'corp-1',
      payload: { work_order_id: index + 1 },
    }));
    const client = makeClient({
      'booking.succeeded': [first, [{ corp_id: 'corp-1', payload: { work_order_id: 101 } }]],
      'interview.passed': [[{ idempotency_key: '100:pass' }]],
    });
    const repo = makeRepository(client);
    const result = await repo.findWorkOrdersPendingPass('2026-05-01');
    expect(result.pending).toHaveLength(99);
    expect(result.nextOffset).toBe(100);
    expect(client.from).toHaveBeenCalledTimes(2);
    const passedQuery = client.from.mock.results[1].value;
    expect(passedQuery.eq).toHaveBeenCalledWith('corp_id', 'corp-1');
    expect(passedQuery.in).toHaveBeenCalledWith(
      'idempotency_key',
      expect.arrayContaining(['100:pass']),
    );
    expect(passedQuery.limit).toHaveBeenCalledWith(100);
    const next = await repo.findWorkOrdersPendingPass('2026-05-01', result.nextOffset);
    expect(next.pending.map((row) => row.workOrderId)).toEqual([101]);
    expect(next.nextOffset).toBe(0);
  });

  it('returns only schedulable interview.passed events from the inclusive time window', async () => {
    const client = makeClient({
      'interview.passed': [
        [
          {
            corp_id: 'corp-1',
            user_id: 'user-1',
            chat_id: 'chat-1',
            bot_im_id: 'bot-1',
            occurred_at: '2026-08-18T10:00:00.000Z',
            payload: { work_order_id: 901 },
          },
          {
            corp_id: 'corp-1',
            user_id: null,
            chat_id: 'chat-invalid',
            occurred_at: '2026-08-18T10:00:00.000Z',
            payload: { work_order_id: 902 },
          },
        ],
      ],
    });

    const result = await makeRepository(client).findRecentInterviewPassed(
      new Date('2026-08-18T10:00:00.000Z'),
      new Date('2026-08-20T10:00:00.000Z'),
    );

    expect(result).toEqual({
      events: [
        {
          corpId: 'corp-1',
          userId: 'user-1',
          chatId: 'chat-1',
          botImId: 'bot-1',
          workOrderId: 901,
          occurredAt: '2026-08-18T10:00:00.000Z',
        },
      ],
      skipped: 1,
    });
  });

  it('reads booking.succeeded payload.group_invite.outcome and leaves legacy rows as null', async () => {
    const client = makeClient({
      'booking.succeeded': [
        [
          { bot_im_id: 'bot-1', payload: { group_invite: { outcome: 'invited' } } },
          { bot_im_id: 'bot-1', payload: { group_invite: { outcome: 'skipped:group_chat' } } },
          { bot_im_id: 'bot-2', payload: { work_order_id: 1 } },
          { bot_im_id: null, payload: null },
        ],
      ],
    });

    const result = await makeRepository(client).findBookingGroupInviteOutcomes(
      '2026-09-14',
      '2026-09-20',
    );

    expect(result).toEqual([
      { botImId: 'bot-1', outcome: 'invited' },
      { botImId: 'bot-1', outcome: 'skipped:group_chat' },
      { botImId: 'bot-2', outcome: null },
      { botImId: null, outcome: null },
    ]);
  });
});
