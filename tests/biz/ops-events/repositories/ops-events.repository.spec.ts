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
          range: jest.fn((from: number) => {
            const pageIndex = Math.floor(from / 1000);
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

  it('paginates pending booking and passed event queries beyond the first 1000 rows', async () => {
    const firstBookingPage = Array.from({ length: 1000 }, (_, index) => ({
      corp_id: 'corp-1',
      user_id: `user-${index + 1}`,
      chat_id: `chat-${index + 1}`,
      bot_im_id: 'bot-1',
      payload: { work_order_id: index + 1 },
    }));
    const secondBookingPage = [
      {
        corp_id: 'corp-1',
        user_id: 'user-1001',
        chat_id: 'chat-1001',
        bot_im_id: 'bot-1',
        payload: { work_order_id: 1001 },
      },
    ];
    const client = makeClient({
      'booking.succeeded': [firstBookingPage, secondBookingPage],
      'interview.passed': [[{ idempotency_key: '1000:pass' }]],
    });

    const result = await makeRepository(client).findWorkOrdersPendingPass('2026-05-01');

    expect(result).toHaveLength(1000);
    expect(result.some((row) => row.workOrderId === 1000)).toBe(false);
    expect(result.some((row) => row.workOrderId === 1001)).toBe(true);
    expect(client.from).toHaveBeenCalledTimes(3);
  });
});
