import { CANDIDATE_FIELD_RISK, MIN_QUOTE_CONTEXT_CHARS } from '@resolution/evidence/policies';
import {
  detectAgentEcho,
  notarizeCandidateClaim,
  verifyQuoteContext,
  verifyQuoteProvenance,
  verifyValueShape,
} from '@resolution/evidence/notary';
import type { CandidateFactClaim } from '@resolution/evidence/claim.types';

/**
 * 公证器三问（宪法 P11 工序 C3/C4/C5）。
 *
 * 本文件取代原 `validateClaimValueAgainstQuote` 的测试矩阵：那套断言的是
 * "正则推不出这个值就拒"（value_not_derivable / strict_field_free_derivation），
 * 已随 C1 从类型层删除——它是语义否决，确定性代码在裁决点没有这项权力。
 */

const NOW = new Date('2026-08-05T10:00:00+08:00');

function claim(
  partial: Partial<CandidateFactClaim> & Pick<CandidateFactClaim, 'field' | 'value'>,
): CandidateFactClaim {
  return {
    claimId: 't1',
    operation: 'set',
    producer: 'model',
    interpretation: 'direct',
    evidence: { quote: '' },
    assertedAt: NOW.toISOString(),
    ...partial,
  } as CandidateFactClaim;
}

describe('字段风险分级与短引文门参数', () => {
  it('风险表覆盖全部十字段', () => {
    expect(Object.keys(CANDIDATE_FIELD_RISK)).toHaveLength(10);
    expect(CANDIDATE_FIELD_RISK.name).toBe('strict_identity');
    expect(CANDIDATE_FIELD_RISK.phone).toBe('strict_identity');
    expect(CANDIDATE_FIELD_RISK.isStudent).toBe('boolean_identity');
    expect(CANDIDATE_FIELD_RISK.height).toBe('normalizable');
  });

  it('短引文门只对语境依赖字段设正数门槛', () => {
    expect(MIN_QUOTE_CONTEXT_CHARS.healthCertificate).toBeGreaterThan(0);
    expect(MIN_QUOTE_CONTEXT_CHARS.isStudent).toBeGreaterThan(0);
    // 自解释 token 裸答合法：抬高会把「性别？」→「男」这类正常应答判死。
    expect(MIN_QUOTE_CONTEXT_CHARS.gender).toBe(0);
    expect(MIN_QUOTE_CONTEXT_CHARS.age).toBe(0);
  });
});

describe('第一问·引文真伪', () => {
  const texts = ['我叫王玥', '139 0000 0002', '我一米六三'];

  it('引文逐字命中候选人原文即过', () => {
    expect(
      verifyQuoteProvenance(
        claim({ field: 'name', value: '王玥', evidence: { quote: '我叫王玥' } }),
        texts,
      ).outcome,
    ).toBe('pass');
  });

  it('引文不在候选人原文里 → quote_not_found（防编造的主力）', () => {
    expect(
      verifyQuoteProvenance(
        claim({ field: 'name', value: '王玥', evidence: { quote: '我的名字是王玥' } }),
        texts,
      ),
    ).toMatchObject({ outcome: 'reject', reason: 'quote_not_found' });
  });

  it('legacy 裸值（无 quote）→ quote_not_found，不再走全文推导补录', () => {
    expect(
      verifyQuoteProvenance(claim({ field: 'name', value: '王玥' }), texts),
    ).toMatchObject({ outcome: 'reject', reason: 'quote_not_found' });
  });

  it('严格身份字段：引文与值失联即判无出处（仍是字符串包含，不是推导）', () => {
    expect(
      verifyQuoteProvenance(
        claim({ field: 'name', value: '王玥', evidence: { quote: '我一米六三' } }),
        texts,
      ),
    ).toMatchObject({ outcome: 'reject', reason: 'quote_not_found' });
  });

  it('值包含检查与语料命中同口径：折空白/全半角，不折标点', () => {
    // 语料那步已折空白，这步若用裸 includes，候选人打「我叫王 玥」会被自己人误拒。
    expect(
      verifyQuoteProvenance(
        claim({ field: 'name', value: '王玥', evidence: { quote: '我叫王 玥' } }),
        ['我叫王 玥'],
      ).outcome,
    ).toBe('pass');
    expect(
      verifyQuoteProvenance(
        claim({ field: 'phone', value: '13912345678', evidence: { quote: '电话１３９１２３４５６７８' } }),
        ['电话１３９１２３４５６７８'],
      ).outcome,
    ).toBe('pass');
    // 值真的不在引文里仍然拒——放宽的是形态差异，不是包含关系本身。
    expect(
      verifyQuoteProvenance(
        claim({ field: 'name', value: '李雷', evidence: { quote: '我叫王玥' } }),
        ['我叫王玥'],
      ),
    ).toMatchObject({ outcome: 'reject', reason: 'quote_not_found' });
  });

  it('手机号忽略分隔符比对', () => {
    expect(
      verifyQuoteProvenance(
        claim({ field: 'phone', value: '13900000002', evidence: { quote: '139 0000 0002' } }),
        texts,
      ).outcome,
    ).toBe('pass');
  });

  it('可归一化字段不再复算：模型说 163、原话"一米六三"，公证器不插手语义', () => {
    expect(
      verifyQuoteProvenance(
        claim({
          field: 'height',
          value: 163,
          interpretation: 'normalized',
          evidence: { quote: '我一米六三' },
        }),
        texts,
      ).outcome,
    ).toBe('pass');
  });
});

describe('第二问·值形状', () => {
  it('整句话当年龄 → invalid_value_shape', () => {
    expect(
      verifyValueShape(claim({ field: 'age', value: '晚上才可以，有吗？' })),
    ).toMatchObject({ outcome: 'reject', reason: 'invalid_value_shape' });
  });

  it('占位手机号被形态门拒（gu2kra6p 族）', () => {
    expect(verifyValueShape(claim({ field: 'phone', value: '13800138000' }))).toMatchObject({
      outcome: 'reject',
      reason: 'invalid_value_shape',
    });
  });

  it('纯数字姓名与称谓后缀被形态门拒', () => {
    expect(verifyValueShape(claim({ field: 'name', value: '13900000002' })).outcome).toBe('reject');
    expect(verifyValueShape(claim({ field: 'name', value: '王老师' })).outcome).toBe('reject');
  });

  it('clear 操作免值验证', () => {
    expect(
      verifyValueShape(claim({ field: 'phone', value: null, operation: 'clear' })).outcome,
    ).toBe('pass');
  });
});

describe('第三问·短引文门与回声', () => {
  it('裸「有」答健康证 → quote_too_short', () => {
    expect(
      verifyQuoteContext(
        claim({ field: 'healthCertificate', value: '有', evidence: { quote: '有' } }),
      ),
    ).toMatchObject({ outcome: 'reject', reason: 'quote_too_short' });
  });

  it('带语境的「有健康证」通过', () => {
    expect(
      verifyQuoteContext(
        claim({ field: 'healthCertificate', value: '有', evidence: { quote: '有健康证' } }),
      ).outcome,
    ).toBe('pass');
  });

  it('绑定 Agent 问句的确认式短答豁免（防重造身份确认死锁）', () => {
    expect(
      verifyQuoteContext(
        claim({
          field: 'isStudent',
          value: false,
          interpretation: 'context_confirmation',
          evidence: { quote: '是的', agentQuestionQuote: '你是社会人士对吧' },
        }),
      ).outcome,
    ).toBe('pass');
  });

  it('严格身份字段豁免短引文门：索名后单独回一条真名合法（badcase 6a7446eb）', () => {
    expect(
      verifyQuoteContext(claim({ field: 'name', value: '张丽鑫', evidence: { quote: '张丽鑫' } }))
        .outcome,
    ).toBe('pass');
  });

  it('回声：引文同时命中我方已发消息 → 转确认，不判错', () => {
    expect(
      detectAgentEcho(
        claim({ field: 'householdProvince', value: '安徽', evidence: { quote: '户籍省份：安徽' } }),
        ['面试要求：先将以下资料补充下发给我\n户籍省份：安徽'],
      ),
    ).toMatchObject({ outcome: 'needs_confirmation', reason: 'quote_echoes_agent_message' });
  });

  it('短引文不参与回声：「男」「24」在双方文本同现是必然，判回声会打死正常自陈', () => {
    expect(detectAgentEcho(claim({ field: 'gender', value: '男', evidence: { quote: '男' } }), ['性别：男']).outcome).toBe('pass');
  });
});

describe('三问串行与 shadow 分档', () => {
  const texts = ['户籍省份：安徽'];
  const assistantTexts = ['面试要求：先将以下资料补充下发给我\n户籍省份：安徽'];
  const echoClaim = claim({
    field: 'householdProvince',
    value: '安徽',
    evidence: { quote: '户籍省份：安徽' },
  });

  it('shadow 期回声只记不拦（迁移三阶段 P0 零行为变化）', () => {
    const result = notarizeCandidateClaim({ claim: echoClaim, candidateTexts: texts, assistantTexts });
    expect(result.verdict.outcome).toBe('pass');
    expect(result.echo.outcome).toBe('needs_confirmation');
  });

  it('切换后回声路由 needs_confirmation', () => {
    const result = notarizeCandidateClaim({
      claim: echoClaim,
      candidateTexts: texts,
      assistantTexts,
      echoRoutesToConfirmation: true,
    });
    expect(result.verdict.outcome).toBe('needs_confirmation');
  });
});
