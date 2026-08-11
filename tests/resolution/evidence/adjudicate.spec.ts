import {
  extractCandidateTexts,
  runCandidateFactAdjudication,
} from '@resolution/evidence/adjudicate';

function msg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

describe('adjudication-runner（端到端编排）', () => {
  it('规则/模型/身份三路 claim 汇总，输出统一裁决视图', () => {
    const result = runCandidateFactAdjudication({
      messages: [
        msg('user', '我叫王玥，13900000002'),
        msg('assistant', '目前是学生还是社会人士？'),
        msg('user', '社会人士，我一米六三'),
      ],
      modelClaimInputs: [
        { field: 'height', value: 163, quote: '我一米六三', operation: 'set' },
      ],
      legacyArgs: { age: '25' }, // 模型裸值：候选人从未说过 → 应 rejected
      sessionAccepted: {},
      profileHints: { phone: '13800000000' }, // 旧档案：应被本轮亲证覆盖
    });

    expect(result.acceptedValues).toMatchObject({
      name: '王玥',
      phone: '13900000002',
      isStudent: false,
      height: 163,
    });
    expect(result.acceptedValues.age).toBeUndefined();
    const legacyAge = result.adjudicated.find((entry) => entry.claim.claimId.startsWith('legacy_age'));
    expect(legacyAge?.decision).toBe('rejected');
    expect(result.profile.fields.phone?.status).toBe('accepted');
    expect(result.profile.fields.phone?.value).toBe('13900000002');
  });

  it('extractCandidateTexts 剥时间后缀与引用块（quote 验证同口径）', () => {
    const texts = extractCandidateTexts([
      msg('user', '[引用 高雅琪：麻烦发下姓名] 我叫王玥\n[消息发送时间：2026-08-05 10:00]'),
      msg('assistant', '好的收到'),
    ]);
    expect(texts).toEqual(['我叫王玥']);
  });

  it('legacy 裸值在候选人全文中有据 → 补录 quote 后 accepted（§10 双读）', () => {
    const result = runCandidateFactAdjudication({
      messages: [msg('user', '性别：女，24岁')],
      legacyArgs: { gender: '女', age: '24' },
      sessionAccepted: {},
      profileHints: {},
    });
    expect(result.acceptedValues.gender).toBe('女');
    expect(result.acceptedValues.age).toBe(24);
  });

  it('同批消息重跑：watermark 与 factsVersion 稳定（Bull 重试幂等）', () => {
    const input = {
      messages: [msg('user', '我叫王玥')],
      sessionAccepted: {},
      profileHints: {},
    };
    const first = runCandidateFactAdjudication(input);
    const second = runCandidateFactAdjudication(input);
    expect(first.messageWatermark).toBe(second.messageWatermark);
    expect(first.factsVersion).toBe(second.factsVersion);
  });
});
