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
  assistantTexts?: string[];
  sessionAccepted?: Parameters<typeof adjudicateCandidateClaims>[0]['sessionAccepted'];
  profileHints?: Parameters<typeof adjudicateCandidateClaims>[0]['profileHints'];
}) {
  const result = adjudicateCandidateClaims({
    claims: params.claims,
    candidateTexts: params.candidateTexts,
    assistantTexts: params.assistantTexts,
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
    // legacy 裸值（无 quote）：没有引文就是没有出处 → quote_not_found。
    // 工序 C1 废除了 no_candidate_evidence——旧口径先拿正则在候选人全文里"推导补录"
    // 一段 quote，推不出才判无据，正是 72.3% 假阳的来源。现在不推导，只看有没有引文。
    const legacy = adjudicate({
      claims: [claim({ field: 'phone', value: '13712345678' })],
      candidateTexts: ['我想找兼职'],
    });
    expect(legacy.adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'quote_not_found',
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

  it('可归一化字段不再复算值：解释权归模型（工序 C1 废除 value_not_derivable）', () => {
    // 旧口径：正则从"我一米六三"推出 163，与声明值 180 不等价 → 拒。
    // 该口径按产者排信任（正则的算术凌驾模型的理解），是 P9 旧阶梯的教义残留，已废除。
    // 引文真实、形状合法即采信；真出错时的兜底是报名级确认流（D3），不是正则复算。
    const result = adjudicate({
      claims: [claim({ field: 'height', value: 180, evidence: { quote: '我一米六三' } })],
      candidateTexts: ['我一米六三'],
    });
    expect(result.adjudicated[0]?.decision).toBe('accepted');
    // 但公证器仍守形状：越界值照拒（第二问不受影响）。
    const outOfRange = adjudicate({
      claims: [claim({ field: 'height', value: 999, evidence: { quote: '我一米六三' } })],
      candidateTexts: ['我一米六三'],
    });
    expect(outOfRange.adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'invalid_value_shape',
    });
  });

  it('quote 复算统一折叠全半角、空白和标点', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'education',
          value: '本科',
          evidence: { quote: '学历: 本科' },
        }),
      ],
      candidateTexts: ['学历：本科'],
    });
    expect(result.adjudicated[0]?.decision).toBe('accepted');
  });

  it('quote 改写即使语义接近也不得命中', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'education',
          value: '本科',
          evidence: { quote: '我本科毕业了' },
        }),
      ],
      candidateTexts: ['我的学历是大学本科'],
    });
    expect(result.adjudicated[0]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'quote_not_found',
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

  it('同字段双有效证据值冲突 → 转候选人终审，不互杀也不静默二选一（工序 C2）', () => {
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
    // 旧行为是两条都判 rejected（连坐互杀）、字段回 missing，候选人被从头重问——
    // 而其中一条通常是对的。现在带值进清单，由 D1 渲染一句复述让本人拍板。
    expect(result.profile.fields.age?.status).toBe('needs_confirmation');
    expect(result.profile.fields.age?.value).toBe(26);
    expect(result.acceptedValues.age).toBeUndefined();
    expect(
      result.adjudicated.every((entry) => entry.decision === 'needs_confirmation'),
    ).toBe(true);
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

  it('严格身份字段：引文与值失联即无出处 → quote_not_found（仍是字符串包含，不是推导）', () => {
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
      rejectionReason: 'quote_not_found',
    });
  });

  it('回声检查（工序 C4）：切换后引文命中我方已发消息 → 转确认', () => {
    const result = adjudicateCandidateClaims({
      claims: [
        claim({
          field: 'householdProvince',
          value: '安徽',
          evidence: { quote: '户籍省份：安徽' },
        }),
      ],
      candidateTexts: ['户籍省份：安徽'],
      assistantTexts: ['面试要求：先将以下资料补充下发给我\n户籍省份：安徽'],
      echoRoutesToConfirmation: true,
      sessionAccepted: {},
      profileHints: {},
      messageWatermark: 'w1',
      factsVersion: 1,
      now: NOW,
    });
    expect(result.adjudicated[0]).toMatchObject({
      decision: 'needs_confirmation',
      rejectionReason: 'quote_echoes_agent_message',
    });
    expect(result.echoDetections).toBe(1);
  });

  it('shadow 期回声只计数不改判（迁移三阶段 P0 零行为变化）', () => {
    const result = adjudicate({
      claims: [
        claim({
          field: 'householdProvince',
          value: '安徽',
          evidence: { quote: '户籍省份：安徽' },
        }),
      ],
      candidateTexts: ['户籍省份：安徽'],
      assistantTexts: ['户籍省份：安徽'],
    });
    expect(result.adjudicated[0]?.decision).toBe('accepted');
    expect(result.echoDetections).toBe(1);
  });
});
