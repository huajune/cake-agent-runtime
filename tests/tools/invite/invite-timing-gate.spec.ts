import {
  evaluateInviteTimingGate,
  hasAcceptedGroupOffer,
  type InviteTimingGateInput,
} from '@tools/invite/invite-timing-gate';

/**
 * badcase 63eefu6c / chat 6a68392bce406a6aee39dd0a（2026-07-29）：
 * 同会话两次把要全职的候选人拉进「深圳餐饮兼职②群」——一次在查岗结论出来前，
 * 一次在候选人问「直接去门店面试吗还是怎么样」时。
 */
const base = (over: Partial<InviteTimingGateInput> = {}): InviteTimingGateInput => ({
  requestedCity: '深圳',
  jobListExecuted: true,
  invitedGroups: [],
  currentUserMessage: '好的',
  ...over,
});

describe('evaluateInviteTimingGate', () => {
  describe('突兀拉群档（no_job_result_this_turn）', () => {
    it('生产复现：本轮没跑过 job_list 就拉群被拒', () => {
      expect(evaluateInviteTimingGate(base({ jobListExecuted: false }))).toEqual({
        decision: 'reject',
        reason: 'no_job_result_this_turn',
      });
    });

    it('本轮仅跑过 job_list 仍拒绝：真无岗与有岗都不能替代候选人同意', () => {
      expect(evaluateInviteTimingGate(base())).toEqual({
        decision: 'reject',
        reason: 'group_consent_required',
      });
    });

    it('预约成功后拉群（场景 1）豁免本档', () => {
      expect(
        evaluateInviteTimingGate(base({ jobListExecuted: false, bookingSucceeded: true })),
      ).toEqual({ decision: 'allow' });
    });

    it('两轮协议第二轮：上一轮征询且本轮明确同意时豁免重复查岗', () => {
      expect(
        evaluateInviteTimingGate(base({ jobListExecuted: false, groupOfferAccepted: true })),
      ).toEqual({ decision: 'allow' });
    });
  });

  describe('重复拉群档（already_invited_city）', () => {
    it('同城市已拉过群时被拒，并带出群名供模型据实回应', () => {
      expect(
        evaluateInviteTimingGate(
          base({
            invitedGroups: [{ groupName: '独立客&深圳餐饮兼职②群', city: '深圳市' }],
          }),
        ),
      ).toEqual({
        decision: 'reject',
        reason: 'already_invited_city',
        invitedGroupName: '独立客&深圳餐饮兼职②群',
      });
    });

    it('城市名带"市"后缀不影响判重（normalizeCity）', () => {
      expect(
        evaluateInviteTimingGate(
          base({ requestedCity: '深圳市', invitedGroups: [{ groupName: 'G', city: '深圳' }] }),
        ).decision,
      ).toBe('reject');
    });

    it('换城市（候选人真搬了）放行，不拦跨城拉群', () => {
      expect(
        evaluateInviteTimingGate(
          base({
            requestedCity: '杭州',
            invitedGroups: [{ groupName: 'G', city: '深圳' }],
            groupOfferAccepted: true,
          }),
        ),
      ).toEqual({ decision: 'allow' });
    });

    it('本档优先级最高：预约成功也不允许重复拉同城群', () => {
      expect(
        evaluateInviteTimingGate(
          base({ bookingSucceeded: true, invitedGroups: [{ groupName: 'G', city: '深圳' }] }),
        ).decision,
      ).toBe('reject');
    });
  });

  describe('打断成单档（booking_progress_signal）', () => {
    it.each([
      '直接去门店面试吗还是怎么样',
      '怎么报名啊',
      '明天几点面试',
      '面试地址在哪',
      '可以报名吗',
      '明天能去面吗',
    ])('候选人推进信号「%s」时拒绝拉群', (currentUserMessage) => {
      expect(evaluateInviteTimingGate(base({ currentUserMessage }))).toEqual({
        decision: 'reject',
        reason: 'booking_progress_signal',
      });
    });

    it.each(['好的谢谢', '算了不考虑了', '没有别的岗位了吗', '这个太远了', '我不想报名了'])(
      '非推进信号「%s」也不等于入群授权',
      (currentUserMessage) => {
        expect(evaluateInviteTimingGate(base({ currentUserMessage }))).toEqual({
          decision: 'reject',
          reason: 'group_consent_required',
        });
      },
    );

    it('预约成功后候选人问"几点面试"属正常收尾，不判打断', () => {
      expect(
        evaluateInviteTimingGate(
          base({ bookingSucceeded: true, currentUserMessage: '明天几点面试' }),
        ),
      ).toEqual({ decision: 'allow' });
    });

    it('时间后缀不干扰信号识别（短期记忆注入）', () => {
      expect(
        evaluateInviteTimingGate(
          base({ currentUserMessage: '怎么报名\n[消息发送时间：2026-07-29 14:00 星期三]' }),
        ).decision,
      ).toBe('reject');
    });

    it('本轮无候选人原话时不误判', () => {
      expect(evaluateInviteTimingGate(base({ currentUserMessage: null }))).toEqual({
        decision: 'reject',
        reason: 'group_consent_required',
      });
    });
  });
});

describe('hasAcceptedGroupOffer', () => {
  it('requires an assistant group offer immediately followed by explicit user consent', () => {
    expect(
      hasAcceptedGroupOffer([
        { role: 'assistant', content: '可以邀请你进上海兼职岗位信息群，你愿意的话回复我“可以”' },
        { role: 'user', content: '可以' },
      ]),
    ).toBe(true);
  });

  it('does not treat a bare consent or a rejection as group consent', () => {
    expect(hasAcceptedGroupOffer([{ role: 'user', content: '可以' }])).toBe(false);
    expect(
      hasAcceptedGroupOffer([
        { role: 'assistant', content: '要不我邀请你进兼职群？' },
        { role: 'user', content: '不用了' },
      ]),
    ).toBe(false);
  });
});
