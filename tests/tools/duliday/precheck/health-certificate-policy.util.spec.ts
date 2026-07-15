import { resolveLocalHealthCertificateEligibility } from '@tools/duliday/precheck/health-certificate-policy.util';

describe('resolveLocalHealthCertificateEligibility', () => {
  it('accepts an explicit local certificate as Sponge value 1', () => {
    expect(
      resolveLocalHealthCertificateEligibility({ latestAnswer: '我有上海本地健康证' }),
    ).toEqual(expect.objectContaining({ status: 'local_valid', spongeValue: 1 }));
  });

  it('keeps a non-local certificate pending and returns the mandatory question', () => {
    const result = resolveLocalHealthCertificateEligibility({
      latestAnswer: '我的是异地健康证',
    });
    expect(result.status).toBe('non_local_needs_confirmation');
    expect(result.spongeValue).toBeNull();
    expect(result.recommendedQuestion).toContain('重新办理');
    expect(result.recommendedQuestion).toContain('本地健康证');
  });

  it('understands a short acceptance after a historical non-local certificate', () => {
    expect(
      resolveLocalHealthCertificateEligibility({
        latestAnswer: '可以',
        historicalValues: ['非本地健康证'],
      }),
    ).toEqual(expect.objectContaining({ status: 'accepts_local_application', spongeValue: 2 }));
  });

  it('understands a short rejection after a historical non-local certificate', () => {
    expect(
      resolveLocalHealthCertificateEligibility({
        latestAnswer: '不接受',
        historicalValues: ['非本地健康证'],
      }),
    ).toEqual(expect.objectContaining({ status: 'rejects_local_application', spongeValue: 3 }));
  });
});
