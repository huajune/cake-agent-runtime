import {
  HEALTH_CERTIFICATE_STATES,
  normalizeHealthCertificateState,
} from '@resolution/candidate/health-certificate-state';
import { resolveLocalHealthCertificateEligibility } from '@resolution/candidate/health-cert-eligibility';

describe('health certificate closed states', () => {
  it.each(HEALTH_CERTIFICATE_STATES)('标准状态重复归一不变：%s', (state) => {
    expect(normalizeHealthCertificateState(state)).toBe(state);
  });

  it.each([
    [true, null],
    ['true', null],
    [false, null],
    ['无', null],
    ['有本地食品健康证', null],
    ['无本地有效健康证，接受办理', '无本地有效健康证，接受办理'],
    ['无本地有效健康证，不接受办理', '无本地有效健康证，不接受办理'],
    ['有（未领证）', '办理中'],
    ['过期', null],
  ])('精确别名 %s → %s，不补全未说明的信息', (input, expected) => {
    expect(normalizeHealthCertificateState(input)).toBe(expected);
  });

  it.each(['办理中', '健康证已过期'])(
    '清洗后 %s 仍被业务消费为当前无可用证，不能升级为有效证',
    (value) => {
      expect(resolveLocalHealthCertificateEligibility({ normalizedKnownValue: value })).toEqual(
        expect.objectContaining({
          status: value === '办理中' ? 'processing' : 'unknown',
          spongeValue: null,
          explicitNoCertificate: true,
        }),
      );
    },
  );

  it.each([null, undefined, {}, 1, '有证吗', '朋友有健康证', '下个月再说', '有，但已经过期很久'])(
    '不从闭集外文本猜测状态：%s',
    (value) => expect(normalizeHealthCertificateState(value)).toBeNull(),
  );
});
