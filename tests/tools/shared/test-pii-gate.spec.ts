import {
  isTestPiiPhoneAllowed,
  maskPhoneForDetails,
  TEST_PII_PHONE_WHITELIST,
} from '@tools/shared/test-pii-gate';

describe('test-pii-gate', () => {
  it('allows whitelisted fake identities (兮兮/旧约定测试号)', () => {
    expect(isTestPiiPhoneAllowed('18271421690')).toBe(true);
    expect(isTestPiiPhoneAllowed('13800000000')).toBe(true);
  });

  it('allows whitelisted phone with formatting noise', () => {
    expect(isTestPiiPhoneAllowed('182-7142-1690')).toBe(true);
    expect(isTestPiiPhoneAllowed(' 18271421690 ')).toBe(true);
  });

  it('rejects real candidate phones (2026-07-27 误建工单 453264 事故形态)', () => {
    expect(isTestPiiPhoneAllowed('15139889675')).toBe(false);
  });

  it('rejects empty/undefined', () => {
    expect(isTestPiiPhoneAllowed('')).toBe(false);
    expect(isTestPiiPhoneAllowed(undefined)).toBe(false);
    expect(isTestPiiPhoneAllowed(null)).toBe(false);
  });

  it('masks phone for details echo', () => {
    expect(maskPhoneForDetails('15139889675')).toBe('151****9675');
    expect(maskPhoneForDetails('')).toBe('(空)');
    expect(maskPhoneForDetails('123')).toBe('***');
  });

  it('whitelist stays aligned with audit script convention', () => {
    expect(TEST_PII_PHONE_WHITELIST).toEqual(
      expect.arrayContaining(['18271421690', '13800000000']),
    );
  });
});
