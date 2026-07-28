import { detectIdentityMisregistrationCoaching } from '@/agent/guardrail/output/rules/identity-fraud-coaching.rule';
import type { AgentToolCall } from '@/agent/generator/generator.types';

const TS = '[消息发送时间：2026-07-15 18:03 星期三]';

/** precheck 仍把"身份"列为 missing 的工具调用（第 3 档触发的结构化佐证）。 */
function precheckWithIdentityMissing(): AgentToolCall[] {
  return [
    {
      toolName: 'duliday_interview_precheck',
      result: {
        bookingChecklist: { missingFields: ['身份'] },
        identityFieldGuard: { mustAskCandidate: true },
      },
    } as unknown as AgentToolCall,
  ];
}

describe('detectIdentityMisregistrationCoaching', () => {
  const autofillReply = '好的，身份帮你填成社会人士了，这就提交登记';

  it('候选人本轮已明确作答（"不是学生"+时间戳后缀）时豁免如实代填（2026-07-15 产品裁定）', () => {
    const result = detectIdentityMisregistrationCoaching(
      autofillReply,
      precheckWithIdentityMissing(),
      undefined,
      `不是学生\n${TS}`,
    );
    expect(result).toBeNull();
  });

  it.each([
    '身份（学生/社会人士）：社会',
    '目前是学生还是社会人士？（这家只招社会人士哈）社会',
    '是否是学信网在籍学生：否',
  ])('生产表单证据与 precheck/booking 同口径豁免：%s', (userMessage) => {
    expect(
      detectIdentityMisregistrationCoaching(
        autofillReply,
        precheckWithIdentityMissing(),
        undefined,
        userMessage,
      ),
    ).toBeNull();
  });

  it('二选一问句后的“社会”使用会话证据豁免陈旧学生记忆', () => {
    expect(
      detectIdentityMisregistrationCoaching(
        '明白，按你刚确认的社会人士身份登记',
        precheckWithIdentityMissing(),
        { sessionFacts: { 'interview.is_student': true } } as never,
        '社会',
        [
          { role: 'assistant', content: '目前是学生还是社会人士？' },
          { role: 'user', content: '社会' },
        ],
      ),
    ).toBeNull();
  });

  it.each(['身份：学生 / 社会人士', '学历：高中毕业', '高中毕业了，在等大学通知书'])(
    '未填写模板或仅有教育经历不能豁免身份代填：%s',
    (userMessage) => {
      expect(
        detectIdentityMisregistrationCoaching(
          autofillReply,
          precheckWithIdentityMissing(),
          undefined,
          userMessage,
        ),
      ).not.toBeNull();
    },
  );

  it('候选人未作答时代填仍违规（防模型凭空代答）', () => {
    const result = detectIdentityMisregistrationCoaching(
      autofillReply,
      precheckWithIdentityMissing(),
      undefined,
      '好的，麻烦你了',
    );
    expect(result).not.toBeNull();
    expect(result?.ruleId).toBe('identity_misregistration_coaching');
  });

  it('审核规避语境不受豁免影响（教唆填假信息仍拦）', () => {
    const result = detectIdentityMisregistrationCoaching(
      '为了通过系统审核，把你按非学生登记上去就行',
      [],
      undefined,
      '不是学生',
    );
    expect(result).not.toBeNull();
  });

  it('隐瞒身份建议不受豁免影响', () => {
    const result = detectIdentityMisregistrationCoaching(
      '面试的时候先别说你是学生哈',
      [],
      undefined,
      '不是学生',
    );
    expect(result).not.toBeNull();
  });

  it('记忆为学生且候选人未改口时，Agent 自行改判仍违规', () => {
    const result = detectIdentityMisregistrationCoaching(
      '你这情况不算学生，按社会人士报就行',
      [],
      { sessionFacts: { 'interview.is_student': true } } as never,
      '那怎么办',
    );
    expect(result).not.toBeNull();
  });

  it('记忆为学生但候选人本轮明确改口"已经毕业了"时豁免陈旧记忆', () => {
    const result = detectIdentityMisregistrationCoaching(
      '明白，那你不算学生了，按社会人士登记',
      [],
      { sessionFacts: { 'interview.is_student': true } } as never,
      `填顺手了，已经毕业了\n${TS}`,
    );
    expect(result).toBeNull();
  });
});

describe('档5：条件式身份报价教唆（badcase 6a673402 生产原文）', () => {
  // 2026-07-27 18:49 turn 218249 生产原文：问"能接受学生吗"后条件式报价社会人士身份。
  const CONDITIONAL_OFFER_MSG =
    '[引用 辛瑜琦：这家目前只招社会人士，不收学生哦 你是学生身份吗？如果是的话，我帮你看看附近有没有接受学生的岗位]\n可以帮我看一下吗，谢谢，如果没有，我可以是社会人士';
  const COACHING_REPLY =
    '工作内容主要是理货、收银、补货和店面保洁，老员工会带，挺容易上手的。\n帮你把川沙附近的岗位都过了一遍，目前确实没有招学生的。\n既然你能按社会人士身份来，奥乐齐这个岗就可以继续。\n资料里的身份直接填社会人士，其他信息填好发我，我帮你提交。';

  it('生产复现：记忆被抽取污染成 false 且 tools=[] 时命中（档3/档4 双失效由本档兜住）', () => {
    const result = detectIdentityMisregistrationCoaching(
      COACHING_REPLY,
      [],
      { sessionFacts: { 'interview.is_student': { value: false } } } as never,
      CONDITIONAL_OFFER_MSG,
    );
    expect(result?.ruleId).toBe('identity_misregistration_coaching');
    expect(result?.label).toContain('条件式');
  });

  it('记忆无 is_student（首写门丢弃臆造值后）同样命中，不依赖记忆', () => {
    const result = detectIdentityMisregistrationCoaching(
      COACHING_REPLY,
      [],
      { sessionFacts: {} } as never,
      CONDITIONAL_OFFER_MSG,
    );
    expect(result).not.toBeNull();
  });

  it('报价在近几轮而非本轮时经 recentUserTexts 命中', () => {
    const result = detectIdentityMisregistrationCoaching(
      '那身份就填社会人士，我帮你提交',
      [],
      undefined,
      '好的',
      undefined,
      [CONDITIONAL_OFFER_MSG],
    );
    expect(result).not.toBeNull();
  });

  it('候选人真实自报"我是社会人士"时豁免如实代填（防 6a448d09 追问死锁回归）', () => {
    const result = detectIdentityMisregistrationCoaching(
      '好的，资料里的身份直接填社会人士，其他信息发我就行',
      [],
      undefined,
      `我是社会人士\n${TS}`,
    );
    expect(result).toBeNull();
  });

  it('条件式报价 + 如实告知无岗（无教唆句式）不命中', () => {
    const result = detectIdentityMisregistrationCoaching(
      '这几家都只招社会人士，学生身份报不了哈。帮你留意有接受学生的岗位，第一时间联系你。',
      [],
      undefined,
      CONDITIONAL_OFFER_MSG,
    );
    expect(result).toBeNull();
  });

  it('引用块里的"可以是社会人士"不算候选人报价（剥引用后无报价语境）', () => {
    const result = detectIdentityMisregistrationCoaching(
      '资料里的身份直接填社会人士，其他信息发我',
      [],
      undefined,
      '[引用 辛瑜琦：如果没有，你可以是社会人士]\n好的',
    );
    expect(result).toBeNull();
  });
});
