import { resolveLocalHealthCertificateEligibility } from '@resolution/candidate/health-cert-eligibility';
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

  describe('否定答法不得判成持证（2026-08-19 修复）', () => {
    // 「没有健康证」逐字包含「有健康证」，肯定判据缺否定前瞻时被判 local_valid/spongeValue=1。
    // 同义的「无健康证」「我没健康证」当时却正确落 unknown——只有最常见的这一种写法翻车，
    // 且健康证是有证约岗位的准入门，判反会让候选人一路走到真实建单才暴露。
    it.each([
      '没有健康证',
      '没有健康证，可以办',
      '没有本地健康证',
      '我没有本地有效健康证',
      '暂时没有健康证',
    ])('%s 不得落 local_valid', (latestAnswer) => {
      const result = resolveLocalHealthCertificateEligibility({ latestAnswer });
      expect(result.status).not.toBe('local_valid');
      expect(result.spongeValue).not.toBe(1);
    });

    it('肯定答法照常判持证（修复不得误伤召回）', () => {
      expect(resolveLocalHealthCertificateEligibility({ latestAnswer: '有健康证' }).status).toBe(
        'local_valid',
      );
      expect(
        resolveLocalHealthCertificateEligibility({ latestAnswer: '我有上海本地健康证' }).status,
      ).toBe('local_valid');
    });
  });
});
