import { adjudicateCandidateClaims } from '@resolution/evidence/engine';
import { pickAcceptedValues } from '@resolution/evidence/profile';
import type { CandidateFactClaim } from '@resolution/evidence/claim.types';

const NOW = new Date('2026-08-05T10:00:00+08:00');

function claim(partial: Partial<CandidateFactClaim> & Pick<CandidateFactClaim, 'field' | 'value'>): CandidateFactClaim {
  return {
    claimId: partial.claimId ?? `test_${partial.field}_1`,
    field: partial.field,
    value: partial.value,
    operation: partial.operation ?? 'set',
    producer: partial.producer ?? 'model',
    interpretation: partial.interpretation ?? 'direct',
    evidence: partial.evidence ?? { quote: '' },
    assertedAt: partial.assertedAt ?? NOW.toISOString(),
  };
}

function adjudicate(params: {
  claims: CandidateFactClaim[];
  candidateTexts: string[];
  sessionAccepted?: Parameters<typeof adjudicateCandidateClaims>[0]['sessionAccepted'];
  profileHints?: Parameters<typeof adjudicateCandidateClaims>[0]['profileHints'];
}) {
  const result = adjudicateCandidateClaims({
    claims: params.claims,
    candidateTexts: params.candidateTexts,
    sessionAccepted: params.sessionAccepted ?? {},
    profileHints: params.profileHints ?? {},
    messageWatermark: 'w1',
    factsVersion: 1,
    now: NOW,
  });
  return { ...result, acceptedValues: pickAcceptedValues(result.profile) };
}

describe('candidate-fact-adjudicator（证据化方案 §12 测试矩阵）', () => {
  it('§12-1 当前轮姓名覆盖历史 Profile 姓名', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'name',
          value: '王玥',
          producer: 'rule',
          evidence: { quote: '我叫王玥' },
        }),
      ],
      candidateTexts: ['我叫王玥'],
      profileHints: { name: '张伟' },
    });
    expect(result.profile.fields.name).toMatchObject({ status: 'accepted', value: '王玥' });
    expect(result.acceptedValues.name).toBe('王玥');
  });

  it('§12-2 当前轮手机号覆盖会话早先手机号（最新者胜，旧 claim superseded）', () => {
    const early = claim({
      claimId: 'rule_phone_1',
      field: 'phone',
      value: '13800000001',
      producer: 'rule',
      evidence: { quote: '13800000001' },
      assertedAt: '2026-08-05T09:00:00+08:00',
    });
    const late = claim({
      claimId: 'rule_phone_2',
      field: 'phone',
      value: '13900000002',
      producer: 'rule',
      operation: 'correct',
      evidence: { quote: '换成13900000002' },
      assertedAt: '2026-08-05T09:30:00+08:00',
    });
    const result = adjudicate({
      claims: [early, late],
      candidateTexts: ['13800000001', '换成13900000002'],
    });
    expect(result.acceptedValues.phone).toBe('13900000002');
    const earlyDecision = result.adjudicated.find((entry) => entry.claim.claimId === 'rule_phone_1');
    expect(earlyDecision?.decision).toBe('superseded');
  });

  it('§12-3/15 模型从 Prompt 复制旧值、候选人从未说过 → rejected', () => {
    // legacy 裸值（无 quote）：全文推导不出 → no_candidate_evidence
    const legacy = adjudicate({
      claims: [claim({ field: 'phone', value: '13712345678' })],
      candidateTexts: ['我想找兼职'],
    });
    expect(legacy.adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'no_candidate_evidence',
    });
    expect(legacy.acceptedValues.phone).toBeUndefined();

    // 显式 claim 但 quote 是编的：quote_not_found
    const fabricated = adjudicate({
      claims: [
        claim({ field: 'name', value: '李雷', evidence: { quote: '我叫李雷' } }),
      ],
      candidateTexts: ['我想找兼职'],
    });
    expect(fabricated.adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'quote_not_found',
    });
  });

  it('§12-14 模型提交合理归一化 claim（"一米六三"→163）纠正裸文本 → accepted', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'height',
          value: 163,
          interpretation: 'normalized',
          evidence: { quote: '我一米六三' },
        }),
      ],
      candidateTexts: ['我一米六三，九十二斤'],
    });
    expect(result.profile.fields.height).toMatchObject({ status: 'accepted', value: 163 });
  });

  it('模型声明值与 quote 推导不符 → value_not_derivable（解释权有边界）', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'height',
          value: 180,
          evidence: { quote: '我一米六三' },
        }),
      ],
      candidateTexts: ['我一米六三'],
    });
    expect(result.adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'value_not_derivable',
    });
  });

  it('§12-8 候选人否定旧资料：clear claim → 字段 missing 且屏蔽历史线索', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'phone',
          value: null,
          operation: 'clear',
          evidence: { quote: '别用之前那个号了' },
        }),
      ],
      candidateTexts: ['别用之前那个号了'],
      profileHints: { phone: '13800000001' },
    });
    expect(result.profile.fields.phone).toMatchObject({ status: 'missing', value: null });
    expect(result.acceptedValues.phone).toBeUndefined();
  });

  it('§12-13 跨会话 Profile 只能成为待确认线索，不进 acceptedValues', () => {
    const result = adjudicate({
      claims: [],
      candidateTexts: ['你好'],
      profileHints: { name: '张伟', age: 25 },
    });
    expect(result.profile.fields.name).toMatchObject({
      status: 'historical_unconfirmed',
      source: 'profile',
    });
    expect(result.acceptedValues.name).toBeUndefined();
    expect(result.acceptedValues.age).toBeUndefined();
  });

  it('同字段双有效证据值冲突 → 整字段 conflicted，不静默二选一', () => {
    const result = adjudicate({
      claims: [
        claim({
          claimId: 'rule_age_1',
          field: 'age',
          value: 24,
          producer: 'rule',
          evidence: { quote: '我24岁' },
        }),
        claim({
          claimId: 'model_age_1',
          field: 'age',
          value: 26,
          evidence: { quote: '26岁也可以说' },
        }),
      ],
      candidateTexts: ['我24岁', '26岁也可以说'],
    });
    expect(result.profile.fields.age?.status).toBe('conflicted');
    expect(result.acceptedValues.age).toBeUndefined();
  });

  it('会话既有高置信值作为基线沿用（无新 claim 字段）', () => {
    const result = adjudicate({
      claims: [],
      candidateTexts: ['明天有空'],
      sessionAccepted: { name: { value: '王玥' } },
    });
    expect(result.profile.fields.name).toMatchObject({
      status: 'accepted',
      source: 'session',
      value: '王玥',
    });
  });

  it('严格身份字段禁自由推导：quote 不含名字本体 → rejected', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'name',
          value: '王玥',
          evidence: { quote: '就用之前登记的名字吧' },
        }),
      ],
      candidateTexts: ['就用之前登记的名字吧'],
    });
    expect(result.adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'strict_field_free_derivation',
    });
  });
});
