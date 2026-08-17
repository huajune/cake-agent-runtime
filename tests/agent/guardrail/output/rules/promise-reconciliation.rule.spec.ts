import type { AgentToolCall } from '@agent/generator/generator.types';
import {
  detectBookingPromiseWithoutBooking,
  detectHandoffPromiseWithoutAction,
} from '@agent/guardrail/output/rules/promise-reconciliation.rule';

const call = (toolName: string, result: unknown = { success: true }): AgentToolCall =>
  ({ toolName, result }) as unknown as AgentToolCall;

describe('handoff 承诺-动作对账（议题 7-1）', () => {
  it('flags a first-person escalation promise with no handoff action this turn', () => {
    const hit = detectHandoffPromiseWithoutAction('我让同事帮你确认下，稍后联系你哈', []);

    expect(hit).toMatchObject({ ruleId: 'handoff_promise_reconciliation', action: 'observe' });
  });

  // "转人工/人工客服"是 human_service_phrase_leak(REVISE) 的治理对象：出站前会被改写成
  // 人设内口径，候选人根本收不到那句话，拿它当"已向候选人做出的承诺"来触发补动作是错的口径。
  // 两条规则正交；改写产物（"我帮你问下同事…"）在二审仍会被本规则接住，不漏。
  it('does not flag 转人工 phrasing — that belongs to human_service_phrase_leak', () => {
    expect(detectHandoffPromiseWithoutAction('我帮你转人工核实下具体原因', [])).toBeNull();
    expect(detectHandoffPromiseWithoutAction('我这边给你转接人工', [])).toBeNull();
  });

  it('does not flag when request_handoff succeeded this turn', () => {
    expect(
      detectHandoffPromiseWithoutAction('我让同事帮你确认下，稍后联系你哈', [
        call('request_handoff'),
      ]),
    ).toBeNull();
  });

  it('does not flag when raise_risk_alert succeeded this turn', () => {
    expect(
      detectHandoffPromiseWithoutAction('我找负责人确认下再联系你', [call('raise_risk_alert')]),
    ).toBeNull();
  });

  it('still flags when the handoff tool call failed', () => {
    expect(
      detectHandoffPromiseWithoutAction('我找负责人确认下再联系你', [
        call('request_handoff', { success: false, _errorType: 'missing_chat_id' }),
      ]),
    ).not.toBeNull();
  });

  // 沿用已下线规则的排除设计：边界声明不是升级承诺。
  it('does not flag a boundary statement about who has the final say', () => {
    expect(
      detectHandoffPromiseWithoutAction('这个具体以门店确认为准哈，我这边看到的是30元/小时', []),
    ).toBeNull();
  });

  it('does not flag a conditional non-promise', () => {
    expect(
      detectHandoffPromiseWithoutAction('如果同事没联系你，随时找我，我再帮你看看', []),
    ).toBeNull();
  });

  it('does not flag ordinary replies', () => {
    expect(detectHandoffPromiseWithoutAction('这家店在杨浦区，时薪30元哈', [])).toBeNull();
    expect(detectHandoffPromiseWithoutAction('', [])).toBeNull();
  });
});

describe('报名将来时承诺（议题 9-4）', () => {
  it('flags a future-tense booking promise with no booking call', () => {
    const hit = detectBookingPromiseWithoutBooking('资料已经齐了，我帮你提交报名哈', []);

    expect(hit).toMatchObject({ ruleId: 'booking_promise_without_booking', action: 'observe' });
  });

  it('does not flag when booking actually succeeded', () => {
    expect(
      detectBookingPromiseWithoutBooking('我帮你提交报名哈', [call('duliday_interview_booking')]),
    ).toBeNull();
  });

  it('does not flag when precheck已放行（下一步动作的自然预告）', () => {
    expect(
      detectBookingPromiseWithoutBooking('我这就帮你提交报名', [
        call('duliday_interview_precheck', { nextAction: 'ready_to_book' }),
      ]),
    ).toBeNull();
  });

  it('leaves完成时态 to B-5（不重复覆盖，避免同一投递物两处记账）', () => {
    expect(detectBookingPromiseWithoutBooking('已经帮你报好了哈', [])).toBeNull();
  });

  it('does not flag ordinary replies', () => {
    expect(detectBookingPromiseWithoutBooking('这家店可以约明天下午面试', [])).toBeNull();
  });
});
