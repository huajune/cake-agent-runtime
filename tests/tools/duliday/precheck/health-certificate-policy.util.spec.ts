import { resolveLocalHealthCertificateEligibility } from '@tools/duliday/precheck/health-certificate-policy.util';
import { normalizeHealthCertificateValue } from '@tools/duliday/precheck/field-normalize.util';

describe('resolveLocalHealthCertificateEligibility', () => {
  it.each(['健康证在办', '正在办健康证', '办理中，预计明天出证'])(
    'normalizes certificate-in-progress as currently absent but willing: %s',
    (value) => {
      expect(normalizeHealthCertificateValue(value)).toBe('无但接受办理健康证');
    },
  );

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

  it.each(['无', '没有', '没办', '还没办', '健康证过期了', '在办', '办理中，还没下证'])(
    'flags explicit no-certificate answers so before_interview jobs can gate: %s (badcase a8gh8d9m)',
    (latestAnswer) => {
      expect(resolveLocalHealthCertificateEligibility({ latestAnswer })).toEqual(
        expect.objectContaining({ status: 'unknown', explicitNoCertificate: true }),
      );
    },
  );

  it('does not flag explicitNoCertificate for 有/无但接受办理/empty', () => {
    expect(resolveLocalHealthCertificateEligibility({ latestAnswer: '有' })).toEqual(
      expect.objectContaining({ status: 'local_valid' }),
    );
    expect(
      resolveLocalHealthCertificateEligibility({ latestAnswer: '无但接受办理健康证' }),
    ).toEqual(expect.objectContaining({ status: 'accepts_local_application' }));
    const empty = resolveLocalHealthCertificateEligibility({});
    expect(empty.status).toBe('unknown');
    expect(empty.explicitNoCertificate).toBeUndefined();
  });
});
