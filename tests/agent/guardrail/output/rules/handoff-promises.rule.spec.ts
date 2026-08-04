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
