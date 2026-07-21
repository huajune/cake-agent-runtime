import {
  ShadowAgreementCounter,
  SHADOW_AGREEMENT_BATCH,
  SHADOW_AGREEMENT_MAX_LAG_MS,
} from '@observability/shadow-agreement-counter';

describe('ShadowAgreementCounter', () => {
  const T0 = 1_700_000_000_000;

  it('攒满一批才落库，落库值等于实际计数', () => {
    const counter = new ShadowAgreementCounter(3, 60_000, T0);
    expect(counter.record(T0)).toBe(0);
    expect(counter.record(T0)).toBe(0);
    expect(counter.record(T0)).toBe(3);
  });

  it('落库后计数归零，不重复计入下一批', () => {
    const counter = new ShadowAgreementCounter(2, 60_000, T0);
    counter.record(T0);
    expect(counter.record(T0)).toBe(2);
    expect(counter.record(T0)).toBe(0);
    expect(counter.record(T0)).toBe(2);
    expect(counter.totalCount).toBe(4);
  });

  // 这条是本次修复的核心：低流量日永远攒不满一批，纯按批会让当天分母恒为 0，
  // 差异率算出来是 NULL 或虚高（2026-07-21 观测期实测）。
  it('超过最大滞后即使不满批也落库', () => {
    const counter = new ShadowAgreementCounter(100, 60_000, T0);
    expect(counter.record(T0 + 10_000)).toBe(0);
    expect(counter.record(T0 + 70_000)).toBe(2);
  });

  it('超时落库后重新计时，不会每次都落', () => {
    const counter = new ShadowAgreementCounter(100, 60_000, T0);
    counter.record(T0 + 70_000); // 落库，计时重置到 T0+70s
    expect(counter.record(T0 + 80_000)).toBe(0);
    expect(counter.record(T0 + 140_000)).toBe(2);
  });

  it('不满批时落库的是实际计数而非批大小常量（否则直接虚报分母）', () => {
    const counter = new ShadowAgreementCounter(100, 60_000, T0);
    counter.record(T0);
    counter.record(T0);
    expect(counter.record(T0 + 60_000)).toBe(3);
  });

  it('drain 交出剩余计数供退出前落库；无待落计数时返回 0', () => {
    const counter = new ShadowAgreementCounter(100, 60_000, T0);
    counter.record(T0);
    counter.record(T0);
    expect(counter.drain(T0)).toBe(2);
    expect(counter.drain(T0)).toBe(0);
  });

  it('生产档位：100 一批、最大滞后 5 分钟', () => {
    expect(SHADOW_AGREEMENT_BATCH).toBe(100);
    expect(SHADOW_AGREEMENT_MAX_LAG_MS).toBe(5 * 60 * 1000);
  });
});
