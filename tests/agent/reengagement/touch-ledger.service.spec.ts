import { TouchLedgerService } from '@agent/reengagement/touch-ledger.service';

describe('TouchLedgerService (outbox state machine + freq)', () => {
  let store: Map<string, unknown>;
  let lists: Map<string, unknown[]>;
  let redis: {
    setNx: jest.Mock;
    get: jest.Mock;
    setex: jest.Mock;
    rpush: jest.Mock;
    expire: jest.Mock;
    lrange: jest.Mock;
  };
  let ledger: TouchLedgerService;

  beforeEach(() => {
    store = new Map();
    lists = new Map();
    redis = {
      setNx: jest.fn(async (key: string, value: unknown) => {
        if (store.has(key)) return false;
        store.set(key, value);
        return true;
      }),
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      setex: jest.fn(async (key: string, _ttl: number, value: unknown) => {
        store.set(key, value);
      }),
      rpush: jest.fn(async (key: string, value: unknown) => {
        const arr = lists.get(key) ?? [];
        arr.push(value);
        lists.set(key, arr);
        return arr.length;
      }),
      expire: jest.fn(async () => 1),
      lrange: jest.fn(async (key: string) => lists.get(key) ?? []),
    };
    ledger = new TouchLedgerService(redis as never);
  });

  it('reserve returns reserved on first call, duplicate_inflight on second', async () => {
    expect(await ledger.reserve('k1')).toBe('reserved');
    expect(await ledger.reserve('k1')).toBe('duplicate_inflight');
  });

  it('reserve returns duplicate_sent once the slot is sent', async () => {
    await ledger.reserve('k1');
    await ledger.markSent('k1', 's1', 1000);
    expect(await ledger.reserve('k1')).toBe('duplicate_sent');
  });

  it('countSentIn24h only counts sent timestamps within the window', async () => {
    const now = 100 * 60 * 60 * 1000;
    await ledger.markSent('a', 's1', now - 1000);
    await ledger.markSent('b', 's1', now - 25 * 60 * 60 * 1000); // outside 24h
    expect(await ledger.countSentIn24h('s1', now)).toBe(1);
  });

  it('isOverFrequencyLimit flips at 2 sent within 24h', async () => {
    const now = 100 * 60 * 60 * 1000;
    await ledger.markSent('a', 's1', now - 1000);
    expect(await ledger.isOverFrequencyLimit('s1', now)).toBe(false);
    await ledger.markSent('b', 's1', now - 2000);
    expect(await ledger.isOverFrequencyLimit('s1', now)).toBe(true);
  });

  it('failed/unknown do NOT count toward frequency (only sent does)', async () => {
    const now = 100 * 60 * 60 * 1000;
    await ledger.reserve('a');
    await ledger.markDeliveryAttempted('a');
    await ledger.markFailedOrUnknown('a', 'unknown');
    expect(await ledger.countSentIn24h('s1', now)).toBe(0);
  });
});
