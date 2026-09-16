import { InterventionService } from '@biz/intervention/intervention.service';
import type {
  GeneralHandoffInterventionPayload,
  RiskInterventionPayload,
} from '@biz/intervention/intervention.service';

describe('InterventionService', () => {
  const userHostingService = {
    isUserPaused: jest.fn(),
    pauseUser: jest.fn(),
  };
  const riskNotifier = {
    notifyConversationRisk: jest.fn(),
  };
  const generalHandoffNotifier = {
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
    recentMessages: [{ role: 'user' as const, content: '滚', timestamp: 1_700_000_000_000 }],
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

  beforeEach(() => {
    jest.clearAllMocks();
    userHostingService.isUserPaused.mockResolvedValue(false);
    userHostingService.pauseUser.mockResolvedValue(undefined);
    riskNotifier.notifyConversationRisk.mockResolvedValue(true);
    generalHandoffNotifier.notify.mockResolvedValue(true);

    service = new InterventionService(
      userHostingService as never,
      riskNotifier as never,
      generalHandoffNotifier as never,
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
  });

  describe('面试后转人工暂停到人工恢复为止（2026-09-16 裁定，chat 6a9f7db6 托管隔天自动恢复酿成事故）', () => {
    it.each(['interview_result_inquiry', 'onboarding_paperwork', 'self_recruited_or_completed'])(
      'pauses permanently for general_handoff reasonCode=%s',
      async (reasonCode) => {
        const payload: GeneralHandoffInterventionPayload = {
          ...baseContext,
          kind: 'general_handoff',
          alertLabel: '面试后对接',
          reasonCode,
          reason: '候选人追问入职安排',
          source: 'agent_tool',
        };
        await service.dispatch(payload);
        expect(userHostingService.pauseUser).toHaveBeenCalledWith(
          'chat-1',
          expect.objectContaining({ permanent: true, reason: '面试后人工对接，需人工恢复托管' }),
        );
      },
    );

    it('pauses permanently for the interview_result_inquiry input risk', async () => {
      await service.dispatch({ ...riskPayload, riskType: 'interview_result_inquiry' });
      expect(userHostingService.pauseUser).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({ permanent: true }),
      );
    });

    it('keeps the default midnight-expiring pause for other handoffs', async () => {
      const payload: GeneralHandoffInterventionPayload = {
        ...baseContext,
        kind: 'general_handoff',
        alertLabel: '需人工跟进',
        reasonCode: 'no_match_or_group_full',
        reason: '无岗且群满',
        source: 'agent_tool',
      };
      await service.dispatch(payload);
      await service.dispatch(riskPayload);
      for (const call of userHostingService.pauseUser.mock.calls) {
        expect(call[1]).toMatchObject({ permanent: false });
      }
    });
  });

  it('pauses and notifies risk via ConversationRiskNotifierService', async () => {
    const result = await service.dispatch(riskPayload);

    expect(userHostingService.pauseUser).toHaveBeenCalledWith('chat-1', expect.any(Object));
    expect(riskNotifier.notifyConversationRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        riskLabel: '辱骂/攻击',
        summary: '候选人辱骂',
        reason: '命中辱骂关键词',
        chatId: 'chat-1',
        pausedUserId: 'chat-1',
      }),
    );
    expect(generalHandoffNotifier.notify).not.toHaveBeenCalled();
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

  it('pauses + notifies via GeneralHandoffNotifierService for general_handoff payload', async () => {
    const generalPayload: GeneralHandoffInterventionPayload = {
      ...baseContext,
      kind: 'general_handoff',
      alertLabel: '需人工跟进',
      reason: '当前会话无 active case 且候选人需人工',
      actionAdvice: '候选人想入群但城市无可用群',
      source: 'agent_tool',
    };

    const result = await service.dispatch(generalPayload);

    expect(userHostingService.pauseUser).toHaveBeenCalledWith('chat-1', expect.any(Object));
    expect(generalHandoffNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        alertLabel: '需人工跟进',
        reason: '当前会话无 active case 且候选人需人工',
        actionAdvice: '候选人想入群但城市无可用群',
        chatId: 'chat-1',
        pausedUserId: 'chat-1',
      }),
    );
    expect(riskNotifier.notifyConversationRisk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dispatched: true, paused: true, alerted: true });
  });
});
