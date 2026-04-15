import { InterventionService } from '@notification/intervention/intervention.service';
import type {
  HandoffInterventionPayload,
  RiskInterventionPayload,
} from '@notification/intervention/intervention.service';

describe('InterventionService', () => {
  const userHostingService = {
    isUserPaused: jest.fn(),
    pauseUser: jest.fn(),
  };
  const recruitmentCaseService = {
    markHandoff: jest.fn(),
  };
  const riskNotifier = {
    notifyConversationRisk: jest.fn(),
  };
  const handoffNotifier = {
    notify: jest.fn(),
  };

  let service: InterventionService;

  const baseContext = {
    chatId: 'chat-1',
    corpId: 'corp-1',
    userId: 'user-1',
    pauseTargetId: 'chat-1',
    botImId: 'bot-im-1',
    botUserName: 'bob',
    contactName: 'Alice',
    currentMessageContent: '滚',
    recentMessages: [
      { role: 'user' as const, content: '滚', timestamp: 1_700_000_000_000 },
    ],
    sessionState: null,
  };

  const riskPayload: RiskInterventionPayload = {
    ...baseContext,
    kind: 'conversation_risk',
    riskType: 'abuse',
    riskLabel: '辱骂/攻击',
    summary: '候选人辱骂',
    reason: '命中辱骂关键词',
    source: 'regex_intercept',
  };

  const handoffPayload: HandoffInterventionPayload = {
    ...baseContext,
    kind: 'onboard_handoff',
    caseId: 'case-9',
    alertLabel: '找不到门店',
    reason: '候选人反馈找不到门店',
    summary: '需要人工协助到店',
    source: 'agent_tool',
    recruitmentCase: {
      id: 'case-9',
      corp_id: 'corp-1',
      chat_id: 'chat-1',
      user_id: 'user-1',
      case_type: 'onboard_followup',
      status: 'active',
      booking_id: 'bk-1',
      booked_at: '2026-04-15T00:00:00Z',
      interview_time: '2026-04-16 10:00:00',
      job_id: 100,
      job_name: '后厨',
      brand_name: '肯德基',
      store_name: '杨浦店',
      bot_im_id: 'bot-im-1',
      followup_window_ends_at: '2026-04-23T00:00:00Z',
      last_relevant_at: '2026-04-15T00:00:00Z',
      metadata: {},
      created_at: '2026-04-15T00:00:00Z',
      updated_at: '2026-04-15T00:00:00Z',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    userHostingService.isUserPaused.mockResolvedValue(false);
    userHostingService.pauseUser.mockResolvedValue(undefined);
    recruitmentCaseService.markHandoff.mockResolvedValue(undefined);
    riskNotifier.notifyConversationRisk.mockResolvedValue(true);
    handoffNotifier.notify.mockResolvedValue(true);

    service = new InterventionService(
      userHostingService as never,
      recruitmentCaseService as never,
      riskNotifier as never,
      handoffNotifier as never,
    );
  });

  it('returns missing_target when pauseTargetId is empty', async () => {
    const result = await service.dispatch({ ...riskPayload, pauseTargetId: '' });

    expect(result).toEqual({
      dispatched: false,
      paused: false,
      alerted: false,
      suppressed: 'missing_target',
    });
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(riskNotifier.notifyConversationRisk).not.toHaveBeenCalled();
  });

  it('returns already_paused without pausing or notifying when user already paused', async () => {
    userHostingService.isUserPaused.mockResolvedValue(true);

    const result = await service.dispatch(riskPayload);

    expect(result.suppressed).toBe('already_paused');
    expect(result.dispatched).toBe(false);
    expect(userHostingService.pauseUser).not.toHaveBeenCalled();
    expect(riskNotifier.notifyConversationRisk).not.toHaveBeenCalled();
    expect(recruitmentCaseService.markHandoff).not.toHaveBeenCalled();
  });

  it('pauses and notifies risk via ConversationRiskNotifierService', async () => {
    const result = await service.dispatch(riskPayload);

    expect(userHostingService.pauseUser).toHaveBeenCalledWith('chat-1');
    expect(riskNotifier.notifyConversationRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        riskLabel: '辱骂/攻击',
        summary: '候选人辱骂',
        reason: '命中辱骂关键词',
        chatId: 'chat-1',
        pausedUserId: 'chat-1',
      }),
    );
    expect(handoffNotifier.notify).not.toHaveBeenCalled();
    expect(recruitmentCaseService.markHandoff).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dispatched: true, paused: true, alerted: true });
  });

  it('pauses + marks handoff + notifies for onboard_handoff payload', async () => {
    const result = await service.dispatch(handoffPayload);

    expect(userHostingService.pauseUser).toHaveBeenCalledWith('chat-1');
    expect(handoffNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        alertLabel: '找不到门店',
        chatId: 'chat-1',
        pausedUserId: 'chat-1',
        recruitmentCase: expect.objectContaining({ id: 'case-9' }),
      }),
    );
    expect(recruitmentCaseService.markHandoff).toHaveBeenCalledWith('case-9');
    expect(riskNotifier.notifyConversationRisk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dispatched: true, paused: true, alerted: true });
  });

  it('reports notify_failed suppression when notifier returns false', async () => {
    riskNotifier.notifyConversationRisk.mockResolvedValue(false);

    const result = await service.dispatch(riskPayload);

    expect(result).toMatchObject({
      dispatched: true,
      paused: true,
      alerted: false,
      suppressed: 'notify_failed',
    });
  });
});
