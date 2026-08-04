import {
  detectHandoffPromiseWithoutHandoff,
  isHandoffPromiseOnlyReply,
} from '@agent/guardrail/output/rules/handoff-promises.rule';
import type { AgentToolCall } from '@agent/generator/generator.types';

function call(
  toolName: string,
  result: Record<string, unknown>,
  status?: AgentToolCall['status'],
): AgentToolCall {
  return { toolName, args: {}, result, status };
}

describe('detectHandoffPromiseWithoutHandoff', () => {
  const PROMISE = '我让同事确认一下，稍等哈';

  it('无升级动作时命中承诺词形', () => {
    expect(detectHandoffPromiseWithoutHandoff(PROMISE, [])).toMatchObject({
      ruleId: 'handoff_promise_without_handoff',
    });
  });

  it('无升级动作时命中让同事发送资料的承诺（v10.38.0 真实 Agent 回归）', () => {
    expect(
      detectHandoffPromiseWithoutHandoff(
        '办理费用一般 100 元左右，需要自费办理，公司不报销哈。具体办理地点我让同事发你一份门店认可的机构清单，稍等～',
        [],
      ),
    ).toMatchObject({
      ruleId: 'handoff_promise_without_handoff',
    });
  });

  it('“发现”不是发送资料承诺', () => {
    expect(
      detectHandoffPromiseWithoutHandoff('我让同事发现了一个数据问题，已经修好了。', []),
    ).toBeNull();
  });

  it.each(['稍后同事会把清单发给你。', '同事稍后会发你一份清单。', '我会请同事把清单发给你。'])(
    '覆盖常见的同事后续发送资料句式：%s',
    (reply) => {
      expect(detectHandoffPromiseWithoutHandoff(reply, [])).toMatchObject({
        ruleId: 'handoff_promise_without_handoff',
      });
    },
  );

  it.each(['同事稍后不会发资料。', '我让同事不要发资料，避免发错。'])(
    '否定的发送动作不是后续承诺：%s',
    (reply) => {
      expect(detectHandoffPromiseWithoutHandoff(reply, [])).toBeNull();
      expect(isHandoffPromiseOnlyReply(reply)).toBe(false);
    },
  );

  it.each([
    '我让同事不要发资料，但我会让负责人发你一份新清单。',
    '同事稍后不会发资料，但负责人稍后会发你清单。',
    '我让同事不要发资料，之后负责人会联系你。',
  ])('同句先否定旧动作、再承诺新动作时仍命中：%s', (reply) => {
    expect(detectHandoffPromiseWithoutHandoff(reply, [])).toMatchObject({
      ruleId: 'handoff_promise_without_handoff',
    });
  });

  it.each([
    '我让同事不用再确认，直接发你一份清单。',
    '我让同事不要再核实，直接发你资料。',
    '我让同事无需回复，直接发你清单。',
    '我让同事别联系你，改成发你资料。',
  ])('后半句省略人工主语、改为正向动作时仍命中：%s', (reply) => {
    expect(detectHandoffPromiseWithoutHandoff(reply, [])).toMatchObject({
      ruleId: 'handoff_promise_without_handoff',
    });
  });

  it.each([
    '我让同事不用再确认，直接把机构清单发给你。',
    '我让同事不用再确认，把机构清单发给你。',
    '我让同事不用回复，稍后把清单发你。',
    '我让同事不用回复，然后把资料发给你。',
  ])('后半句宾语前置的发送承诺仍命中：%s', (reply) => {
    expect(detectHandoffPromiseWithoutHandoff(reply, [])).toMatchObject({
      ruleId: 'handoff_promise_without_handoff',
    });
  });

  it('同一人工主语后的动作全部是否定时仍放行', () => {
    expect(
      detectHandoffPromiseWithoutHandoff('我让同事不用再确认，也不要发你资料。', []),
    ).toBeNull();
  });

  it.each([
    '我让同事别联系你，我自己回复你就行。',
    '我让同事不用再确认，我直接发你现有清单。',
    '我让负责人不要处理，我自己来处理。',
    '我让店长不用回复，我来答复你。',
    '我让同事不用回复，你回复我就行。',
    '我让同事不要发资料，现有资料提供的信息已经够了。',
    '我让同事别联系你，联系方式已经发过了。',
    '我让负责人不要处理，这个处理结果已经作废。',
    '我让同事不用回复，回复已经收到了。',
    '我让同事别联系你，联系已经中断了。',
    '我让负责人不用答复，答复已经发来了。',
    '我让同事不要处理，处理已经完成了。',
  ])('后续出现新主语或动作名词时不继承人工主体：%s', (reply) => {
    expect(detectHandoffPromiseWithoutHandoff(reply, [])).toBeNull();
    expect(isHandoffPromiseOnlyReply(reply)).toBe(false);
  });

  it('request_handoff dispatched=true 豁免', () => {
    const calls = [call('request_handoff', { dispatched: true })];
    expect(detectHandoffPromiseWithoutHandoff(PROMISE, calls)).toBeNull();
  });

  it('raise_risk_alert accepted=true 豁免', () => {
    const calls = [call('raise_risk_alert', { accepted: true })];
    expect(detectHandoffPromiseWithoutHandoff(PROMISE, calls)).toBeNull();
  });

  // 2026-08-04 守卫审计 …_1785740343589 / …_1785748484273：预约失败时 booking 工具
  // 自动暂停托管+真人接管，且 replyInstruction 亲自指示"我让同事确认一下，稍等"——
  // 该形态是如实陈述，不豁免会逼 rewrite 编出"那就给你约明天…"类完成暗示。
  it('booking 失败自动暂停（hostingPaused=true）豁免', () => {
    const calls = [
      call('duliday_interview_precheck', { success: true }, 'ok'),
      call(
        'duliday_interview_booking',
        { success: false, errorType: 'booking.rejected', hostingPaused: true },
        'error',
      ),
    ];
    expect(detectHandoffPromiseWithoutHandoff(PROMISE, calls)).toBeNull();
  });

  it('booking 早退失败（无 hostingPaused 打标，未暂停托管）不豁免', () => {
    const calls = [
      call('duliday_interview_booking', { success: false, errorType: 'booking.rejected' }, 'error'),
    ];
    expect(detectHandoffPromiseWithoutHandoff(PROMISE, calls)).toMatchObject({
      ruleId: 'handoff_promise_without_handoff',
    });
  });

  it('booking 成功（无打标）不构成升级豁免', () => {
    const calls = [call('duliday_interview_booking', { success: true }, 'ok')];
    expect(detectHandoffPromiseWithoutHandoff(PROMISE, calls)).toMatchObject({
      ruleId: 'handoff_promise_without_handoff',
    });
  });

  it('边界声明"具体以门店确认为准"不命中', () => {
    expect(detectHandoffPromiseWithoutHandoff('排班细节具体以门店确认为准哈', [])).toBeNull();
  });
});

// 2026-08-04 审计 P0-1："删除承诺、其余逐字保留"在整条皆承诺的首版上保留空集，
// rewrite 被逼成自由创作（生产编出着装要求/"已拉你进群"/约面时间）。
describe('isHandoffPromiseOnlyReply', () => {
  it('整条只有承诺句 → true（trace …_1785748484273 首版）', () => {
    expect(isHandoffPromiseOnlyReply('我让同事确认一下，稍等哈')).toBe(true);
  });

  it('承诺 + 同句尾巴 → true（trace …_1785489639414 首版）', () => {
    expect(isHandoffPromiseOnlyReply('衣服要求我让同事确认下，有消息告诉你')).toBe(true);
  });

  it('寒暄 + 承诺 → true（剥后只剩寒暄）', () => {
    expect(isHandoffPromiseOnlyReply('好的！\n我让同事帮你确认下排班，稍等哈')).toBe(true);
  });

  it('承诺外还有实质内容 → false（trace …_1785725545751 形态，交给 rewrite 删承诺留其余）', () => {
    expect(
      isHandoffPromiseOnlyReply(
        '这家店的要求和你不太匹配，我帮你看了下附近暂时没有其他合适的岗位。\n\n我让同事帮你跟进下，有合适的会第一时间联系你',
      ),
    ).toBe(false);
  });

  it('不含承诺词形 → false', () => {
    expect(isHandoffPromiseOnlyReply('面试通知一般发到企业微信消息里，你检查下消息列表')).toBe(
      false,
    );
  });
});
