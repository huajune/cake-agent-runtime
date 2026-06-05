import { SupabaseCircuitBreaker } from '@infra/supabase/supabase-circuit-breaker';

describe('SupabaseCircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-06-05T00:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens after the failure threshold, then allows one half-open probe after cooldown', () => {
    const breaker = new SupabaseCircuitBreaker(2, 1000, 500);

    expect(breaker.canRequest()).toBe(true);
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');

    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.canRequest()).toBe(false);

    jest.advanceTimersByTime(1000);
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canRequest()).toBe(false);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
  });

  it('reopens when the half-open probe fails', () => {
    const breaker = new SupabaseCircuitBreaker(1, 1000, 500);

    breaker.recordFailure();
    jest.advanceTimersByTime(1000);
    expect(breaker.canRequest()).toBe(true);

    breaker.recordFailure();

    expect(breaker.getState()).toBe('open');
    expect(breaker.canRequest()).toBe(false);
  });

  it('throttles rejection logs while open', () => {
    const breaker = new SupabaseCircuitBreaker(1, 1000, 500);
    breaker.recordFailure();

    expect(breaker.shouldLogRejection()).toBe(true);
    expect(breaker.shouldLogRejection()).toBe(false);

    jest.advanceTimersByTime(500);
    expect(breaker.shouldLogRejection()).toBe(true);
  });
});
