import { RequestContextService } from '@observability/context/request-context.service';

describe('RequestContextService', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  it('returns an empty context outside an AsyncLocalStorage scope', () => {
    expect(service.get()).toEqual({});
  });

  it('runs callbacks with compacted context values', () => {
    const result = service.run(
      {
        traceId: 'trace-1',
        chatId: '',
        userId: undefined,
        scenario: 'default',
      },
      () => service.get(),
    );

    expect(result).toEqual({
      traceId: 'trace-1',
      scenario: 'default',
    });
  });

  it('merges nested context over the existing scope', () => {
    service.run({ traceId: 'trace-1', chatId: 'chat-1', scenario: 'outer' }, () => {
      service.run({ chatId: 'chat-2', userId: 'user-1' }, () => {
        expect(service.get()).toEqual({
          traceId: 'trace-1',
          chatId: 'chat-2',
          scenario: 'outer',
          userId: 'user-1',
        });
      });

      expect(service.get()).toEqual({
        traceId: 'trace-1',
        chatId: 'chat-1',
        scenario: 'outer',
      });
    });
  });

  it('keeps context available across awaited async work', async () => {
    await service.run({ traceId: 'trace-async' }, async () => {
      await Promise.resolve();
      expect(service.get()).toEqual({ traceId: 'trace-async' });
    });
  });
});
