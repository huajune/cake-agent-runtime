import { SupabaseCircuitBreaker } from '@infra/supabase/supabase-circuit-breaker';

describe('SupabaseCircuitBreaker', () => {
  const operation = 'RPC:get_dashboard_overview';

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-06-05T00:00:00.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens after the failure threshold, then allows one half-open probe after cooldown', () => {
    const breaker = new SupabaseCircuitBreaker(2, 1000, 500);

    expect(breaker.canRequest(operation)).toBe(true);
    breaker.recordFailure(operation);
    expect(breaker.getState(operation)).toBe('closed');

    breaker.recordFailure(operation);
    expect(breaker.getState(operation)).toBe('open');
    expect(breaker.canRequest(operation)).toBe(false);

    jest.advanceTimersByTime(1000);
    expect(breaker.canRequest(operation)).toBe(true);
    expect(breaker.getState(operation)).toBe('half-open');
    expect(breaker.canRequest(operation)).toBe(false);

    breaker.recordSuccess(operation);
    expect(breaker.getState(operation)).toBe('closed');
    expect(breaker.canRequest(operation)).toBe(true);
  });

  it('reopens when the half-open probe fails', () => {
    const breaker = new SupabaseCircuitBreaker(1, 1000, 500);

    breaker.recordFailure(operation);
    jest.advanceTimersByTime(1000);
    expect(breaker.canRequest(operation)).toBe(true);

    breaker.recordFailure(operation);

    expect(breaker.getState(operation)).toBe('open');
    expect(breaker.canRequest(operation)).toBe(false);
  });

  it('throttles rejection logs while open', () => {
    const breaker = new SupabaseCircuitBreaker(1, 1000, 500);
    breaker.recordFailure(operation);

    expect(breaker.shouldLogRejection(operation)).toBe(true);
    expect(breaker.shouldLogRejection(operation)).toBe(false);

    jest.advanceTimersByTime(500);
    expect(breaker.shouldLogRejection(operation)).toBe(true);
  });

  it('isolates failure and half-open state by operation', () => {
    const breaker = new SupabaseCircuitBreaker(1, 1000, 500);
    const healthyOperation = 'SELECT:user_activity';

    breaker.recordFailure(operation);

    expect(breaker.getState(operation)).toBe('open');
    expect(breaker.canRequest(operation)).toBe(false);
    expect(breaker.getState(healthyOperation)).toBe('closed');
    expect(breaker.canRequest(healthyOperation)).toBe(true);

    breaker.recordSuccess(healthyOperation);
    expect(breaker.getState(operation)).toBe('open');
  });
});
