import { produceIdentityClaim } from '@resolution/evidence/producers/student-identity';

const AT = '2026-08-05T10:00:00+08:00';

function msg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

describe('identity-claim.producer（证据化 Phase 1：IdentityEvidence → Claim）', () => {
  it('§12-5 Agent 单值确认问句 + 候选人答"对" → confirmation claim', () => {
    const result = produceIdentityClaim({
      messages: [msg('assistant', '你是"社会人士"对吧？'), msg('user', '对')],
      assertedAt: AT,
    });
    expect(result).toMatchObject({
      field: 'isStudent',
      value: false,
      producer: 'confirmation_resolver',
      interpretation: 'context_confirmation',
    });
  });

  it('§12-6 二选一问句 + 短答案"社会" → choice_answer claim', () => {
    const result = produceIdentityClaim({
      messages: [msg('assistant', '目前是学生还是社会人士？'), msg('user', '社会')],
      assertedAt: AT,
    });
    expect(result).toMatchObject({ field: 'isStudent', value: false, producer: 'rule' });
  });

  it('§12-7 无绑定问句时"好的"不能确认身份', () => {
    const result = produceIdentityClaim({
      messages: [msg('assistant', '这个岗位明天可以面试'), msg('user', '好的')],
      assertedAt: AT,
    });
    expect(result).toBeNull();
  });

  it('§12-9 学生被拒后改口社会人士：未经二次核实不产 claim', () => {
    const result = produceIdentityClaim({
      messages: [
        msg('user', '我是学生'),
        msg('assistant', '这个岗位不要学生哈'),
        msg('user', '我是社会人士'),
      ],
      assertedAt: AT,
    });
    expect(result).toBeNull();
  });

  it('§12-9 改口经核实问句二次确认后产 claim', () => {
    const result = produceIdentityClaim({
      messages: [
        msg('user', '我是学生'),
        msg('assistant', '这个岗位不要学生哈'),
        msg('user', '我是社会人士'),
        msg('assistant', '如实填写不影响推荐其它岗位，确认一下你是学生还是社会人士？'),
        msg('user', '社会人士'),
      ],
      assertedAt: AT,
    });
    expect(result).toMatchObject({ field: 'isStudent', value: false });
  });

  it('直接自认学生 → direct claim（诚实方向不设门槛）', () => {
    const result = produceIdentityClaim({
      messages: [msg('user', '我现在是学生')],
      assertedAt: AT,
    });
    expect(result).toMatchObject({ field: 'isStudent', value: true, interpretation: 'direct' });
  });
});
