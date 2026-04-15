import { OnboardFollowupMonitorService } from '@biz/recruitment-case/services/onboard-followup-monitor.service';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';
import { EnterpriseMessageCallbackDto, MessageType, ContactType, MessageSource } from '@wecom/message/ingress/message-callback.dto';

describe('OnboardFollowupMonitorService', () => {
  const mockRecruitmentCaseService = {
    getActiveOnboardFollowupCase: jest.fn(),
    markHandoff: jest.fn(),
  };

  const mockStageResolver = {
    isRelevantToOnboardFollowup: jest.fn(),
  };

  const mockUserHostingService = {
    isUserPaused: jest.fn(),
    pauseUser: jest.fn(),
  };

  const mockChatSessionService = {
    getChatHistory: jest.fn(),
  };

  const mockSessionService = {
    getSessionState: jest.fn(),
  };

  const mockNotifierService = {
    notify: jest.fn(),
  };

  const activeCase: RecruitmentCaseRecord = {
    id: 'case-1',
    corp_id: 'corp-1',
    chat_id: 'chat-1',
    user_id: 'contact-1',
    case_type: 'onboard_followup',
    status: 'active',
    booking_id: 'BK-1001',
    booked_at: '2026-04-15T08:00:00.000Z',
    interview_time: '2026-04-16 14:00:00',
    job_id: 123,
    job_name: '店员',
    brand_name: '瑞幸',
    store_name: '陆家嘴店',
    bot_im_id: 'bot-im-1',
    followup_window_ends_at: '2026-04-22T08:00:00.000Z',
    last_relevant_at: '2026-04-15T08:00:00.000Z',
    metadata: {},
    created_at: '2026-04-15T08:00:00.000Z',
    updated_at: '2026-04-15T08:00:00.000Z',
  };

  const messageData: EnterpriseMessageCallbackDto = {
    orgId: 'corp-1',
    token: 'token-1',
    botId: 'bot-1',
    botUserId: 'manager-a',
    imBotId: 'bot-im-1',
    chatId: 'chat-1',
    imContactId: 'contact-1',
    messageType: MessageType.TEXT,
    messageId: 'msg-1',
    timestamp: '1713168000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    contactName: '小王',
    payload: { text: '我到店了但是店长不在' },
  };

  let service: OnboardFollowupMonitorService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecruitmentCaseService.getActiveOnboardFollowupCase.mockResolvedValue(activeCase);
    mockRecruitmentCaseService.markHandoff.mockResolvedValue(activeCase);
    mockStageResolver.isRelevantToOnboardFollowup.mockReturnValue(true);
    mockUserHostingService.isUserPaused.mockResolvedValue(false);
    mockUserHostingService.pauseUser.mockResolvedValue(undefined);
    mockChatSessionService.getChatHistory.mockResolvedValue([
      { role: 'user', content: '我到店了但是店长不在', timestamp: 1713168000000 },
    ]);
    mockSessionService.getSessionState.mockResolvedValue(null);
    mockNotifierService.notify.mockResolvedValue(true);

    service = new OnboardFollowupMonitorService(
      mockRecruitmentCaseService as never,
      mockStageResolver as never,
      mockUserHostingService as never,
      mockChatSessionService as never,
      mockSessionService as never,
      mockNotifierService as never,
    );
  });

  it('should pause hosting and hand off when onboarding coordination issue is detected', async () => {
    const result = await service.checkAndHandle({
      messageData,
      content: '我到店了但是店长不在',
    });

    expect(result).toEqual(
      expect.objectContaining({
        hit: true,
        paused: true,
        alerted: true,
      }),
    );
    expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('chat-1');
    expect(mockRecruitmentCaseService.markHandoff).toHaveBeenCalledWith('case-1');
    expect(mockNotifierService.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        alertLabel: '到店无人接待',
        chatId: 'chat-1',
      }),
    );
  });

  it('should skip when there is no active onboarding case', async () => {
    mockRecruitmentCaseService.getActiveOnboardFollowupCase.mockResolvedValue(null);

    const result = await service.checkAndHandle({
      messageData,
      content: '我到店了但是店长不在',
    });

    expect(result).toEqual({ hit: false, paused: false, alerted: false });
    expect(mockUserHostingService.pauseUser).not.toHaveBeenCalled();
  });
});
