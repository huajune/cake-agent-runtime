import {
  produceLegacyModelClaims,
  produceModelClaims,
} from '@resolution/evidence/producers/model-claims';

const AT = '2026-08-05T10:00:00+08:00';

describe('model-claim.producer', () => {
  it('显式 claims：operation 缺省为 set，clear 时 value 置 null', () => {
    const claims = produceModelClaims(
      [
        { field: 'height', value: 163, quote: '我一米六三' },
        { field: 'phone', value: '随便什么', operation: 'clear', quote: '别用之前那个号' },
      ],
      AT,
    );
    expect(claims[0]).toMatchObject({
      field: 'height',
      value: 163,
      operation: 'set',
      producer: 'model',
      evidence: { quote: '我一米六三' },
    });
    expect(claims[1]).toMatchObject({ operation: 'clear', value: null });
  });

  it('legacy 裸值：quote 为空（交裁决器全文推导），空值与非法字段名被过滤', () => {
    const claims = produceLegacyModelClaims(
      {
        name: '王玥',
        phone: '',
        age: undefined,
        // @ts-expect-error 非法字段名应被运行时过滤
        salary: '20',
      },
      AT,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      field: 'name',
      value: '王玥',
      producer: 'model',
      evidence: { quote: '' },
    });
    expect(claims[0].claimId.startsWith('legacy_')).toBe(true);
  });
});
