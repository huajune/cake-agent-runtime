import { resolveLocalHealthCertificateEligibility } from '@resolution/candidate/health-cert-eligibility';

describe('resolveLocalHealthCertificateEligibility', () => {
  it('本地有效健康证映射为 Sponge 1', () => {
    expect(
      resolveLocalHealthCertificateEligibility({ latestAnswer: '我有上海本地健康证' }),
    ).toEqual(expect.objectContaining({ status: 'local_valid', spongeValue: 1 }));
  });

  it('异地证保持待确认并返回强制追问', () => {
    const result = resolveLocalHealthCertificateEligibility({ latestAnswer: '我的是异地健康证' });
    expect(result.status).toBe('non_local_needs_confirmation');
    expect(result.spongeValue).toBeNull();
    expect(result.recommendedQuestion).toContain('重新办理');
    expect(result.recommendedQuestion).toContain('本地健康证');
  });

  it('历史异地证后识别短答接受/拒绝', () => {
    expect(
      resolveLocalHealthCertificateEligibility({
        latestAnswer: '可以',
        historicalValues: ['非本地健康证'],
      }),
    ).toEqual(expect.objectContaining({ status: 'accepts_local_application', spongeValue: 2 }));
    expect(
      resolveLocalHealthCertificateEligibility({
        latestAnswer: '不接受',
        historicalValues: ['非本地健康证'],
      }),
    ).toEqual(expect.objectContaining({ status: 'rejects_local_application', spongeValue: 3 }));
  });

  it.each(['无', '没有', '没办', '还没办', '健康证过期了', '在办', '办理中，还没下证'])(
    '明确无可用证时标记 explicitNoCertificate：%s',
    (latestAnswer) => {
      expect(resolveLocalHealthCertificateEligibility({ latestAnswer })).toEqual(
        expect.objectContaining({ status: 'unknown', explicitNoCertificate: true }),
      );
    },
  );

  it('有证、接受办理、空值不误标 explicitNoCertificate', () => {
    expect(resolveLocalHealthCertificateEligibility({ latestAnswer: '有' })).toEqual(
      expect.objectContaining({ status: 'local_valid' }),
    );
    expect(
      resolveLocalHealthCertificateEligibility({ latestAnswer: '无但接受办理健康证' }),
    ).toEqual(expect.objectContaining({ status: 'accepts_local_application' }));
    expect(resolveLocalHealthCertificateEligibility({}).explicitNoCertificate).toBeUndefined();
  });

  it.each([
    '没有健康证',
    '没有健康证，可以办',
    '没有本地健康证',
    '我没有本地有效健康证',
    '暂时没有健康证',
  ])('否定答法不得判成持证：%s', (latestAnswer) => {
    const result = resolveLocalHealthCertificateEligibility({ latestAnswer });
    expect(result.status).not.toBe('local_valid');
    expect(result.spongeValue).not.toBe(1);
  });

  it('肯定答法照常判持证', () => {
    expect(resolveLocalHealthCertificateEligibility({ latestAnswer: '有健康证' }).status).toBe(
      'local_valid',
    );
  });
});
