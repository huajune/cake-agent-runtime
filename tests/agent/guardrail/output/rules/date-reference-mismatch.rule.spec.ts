import { detectDateReferenceMismatch } from '@agent/guardrail/output/rules/date-reference-mismatch.rule';

describe('detectDateReferenceMismatch (badcase nau6xunv 当天面试被说成明天)', () => {
  // 2026-07-28 12:00 Asia/Shanghai = 2026-07-28T04:00:00Z
  const now = new Date('2026-07-28T04:00:00.000Z');

  it('flags the badcase verbatim: 当天 7-28 却说"明天 7 月 28 日"', () => {
    const hit = detectDateReferenceMismatch(
      '你的面试是安排在明天 7 月 28 日 15:00，不是今天哦',
      now,
    );
    expect(hit?.ruleId).toBe('date_reference_mismatch');
    expect(hit?.label).toContain('今天是 7 月 28 日');
  });

  it('passes correct 明天 pairing (7-29)', () => {
    expect(detectDateReferenceMismatch('明天（7月29日）10:30 记得参加面试', now)).toBeNull();
  });

  it('passes correct 今天 pairing and flags wrong 今天', () => {
    expect(detectDateReferenceMismatch('今天 7 月 28 日 15:00 的面试别忘了', now)).toBeNull();
    expect(detectDateReferenceMismatch('今天（7月29日）的面试别忘了', now)?.ruleId).toBe(
      'date_reference_mismatch',
    );
  });

  it('passes 后天 pairing and dates without relative words', () => {
    expect(detectDateReferenceMismatch('后天（7月30日）也可以约', now)).toBeNull();
    expect(detectDateReferenceMismatch('面试定在 8 月 3 日 11:00', now)).toBeNull();
    expect(detectDateReferenceMismatch('明天上午面试，记得带身份证', now)).toBeNull();
  });

  it('大后天不被"后天"吃掉：正确的 +3 天配对放行（2026-08-04 生产 6a3ccb21 同型）', () => {
    // now=7-28：后天=7-30，大后天=7-31
    expect(
      detectDateReferenceMismatch(
        '你看后天（7月30日）下午1点，或者大后天（7月31日）下午1点都可以',
        now,
      ),
    ).toBeNull();
  });

  it('大后天配错日期时按 +3 天口径拦截并点名"大后天"', () => {
    const hit = detectDateReferenceMismatch('大后天（7月30日）下午1点见', now);
    expect(hit?.ruleId).toBe('date_reference_mismatch');
    expect(hit?.label).toContain('"大后天"应为 7 月 31 日');
  });

  it('handles year boundary: 12-31 的"明天（1月1日）"合法', () => {
    // 2026-12-31 20:00 Asia/Shanghai
    const nye = new Date('2026-12-31T12:00:00.000Z');
    expect(detectDateReferenceMismatch('明天（1月1日）门店正常面试', nye)).toBeNull();
  });
});
