import { produceDirectFieldClaims } from '@memory/facts/candidate/producers/direct-field-claim.producer';

const AT = '2026-08-05T10:00:00+08:00';
const NOW = new Date(AT);

describe('direct-field-claim.producer 规则逐条锚定', () => {
  it('逐条消息解析，quote 精确锚到命中消息、messageIndex 对应位置', () => {
    const claims = produceDirectFieldClaims({
      candidateTexts: ['我叫王玥', '13900000002，我一米六三'],
      assertedAt: AT,
      now: NOW,
    });
    const name = claims.find((c) => c.field === 'name');
    const phone = claims.find((c) => c.field === 'phone');
    const height = claims.find((c) => c.field === 'height');
    expect(name).toMatchObject({
      value: '王玥',
      producer: 'rule',
      evidence: { quote: '我叫王玥', messageIndex: 0 },
    });
    expect(phone).toMatchObject({ value: '13900000002', evidence: { messageIndex: 1 } });
    expect(height).toMatchObject({ value: 163 });
  });

  it('同字段多条命中全部产出（由裁决器按最新者胜归并）', () => {
    const claims = produceDirectFieldClaims({
      candidateTexts: ['我24岁', '记错了，25岁'],
      assertedAt: AT,
      now: NOW,
    });
    expect(claims.filter((c) => c.field === 'age')).toHaveLength(2);
  });

  it('isStudent 不由本 producer 产出（身份走唯一识别器）', () => {
    const claims = produceDirectFieldClaims({
      candidateTexts: ['我是学生'],
      assertedAt: AT,
      now: NOW,
    });
    expect(claims.find((c) => c.field === 'isStudent')).toBeUndefined();
  });

  it('空白消息跳过、无命中不产 claim、claimId 唯一', () => {
    const claims = produceDirectFieldClaims({
      candidateTexts: ['  ', '想找晚班', '13900000002'],
      assertedAt: AT,
      now: NOW,
    });
    expect(claims).toHaveLength(1);
    expect(new Set(claims.map((c) => c.claimId)).size).toBe(claims.length);
  });
});
