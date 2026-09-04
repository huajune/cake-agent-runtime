import {
  evaluateInviteTimingGate,
  type InviteTimingGateInput,
} from '@tools/invite/invite-timing-gate';

/**
 * badcase 63eefu6c / chat 6a68392bce406a6aee39dd0a（2026-07-29）：
 * 同会话两次把要全职的候选人拉进「深圳餐饮兼职②群」——一次在查岗结论出来前，
 * 一次在候选人问「直接去门店面试吗还是怎么样」时。
 */
const base = (over: Partial<InviteTimingGateInput> = {}): InviteTimingGateInput => ({
  requestedCity: '深圳',
  invitedGroups: [],
  ...over,
});

describe('evaluateInviteTimingGate', () => {
  describe('对话语义由主 Agent 裁决', () => {
    it('没有重复拉群事实时直接放行，不接收或解析聊天文本', () => {
      expect(evaluateInviteTimingGate(base())).toEqual({ decision: 'allow' });
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
          }),
        ),
      ).toEqual({ decision: 'allow' });
    });

    it('同城市重复拉群始终拒绝', () => {
      expect(
        evaluateInviteTimingGate(base({ invitedGroups: [{ groupName: 'G', city: '深圳' }] }))
          .decision,
      ).toBe('reject');
    });
  });
});
