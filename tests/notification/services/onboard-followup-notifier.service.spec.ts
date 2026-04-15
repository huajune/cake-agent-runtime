import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';
import { OnboardFollowupCardRenderer } from '@notification/renderers/onboard-followup-card.renderer';
import { OnboardFollowupNotifierService } from '@notification/services/onboard-followup-notifier.service';

describe('OnboardFollowupNotifierService', () => {
  const mockPrivateChatChannel = {
    send: jest.fn<Promise<boolean>, [Record<string, unknown>]>(),
  };

  const mockRenderer = {
    buildCard: jest.fn(),
  } as unknown as jest.Mocked<OnboardFollowupCardRenderer>;

  let service: OnboardFollowupNotifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrivateChatChannel.send.mockResolvedValue(true);
    mockRenderer.buildCard.mockReturnValue({ kind: 'onboard-followup-card' });
    service = new OnboardFollowupNotifierService(mockPrivateChatChannel as never, mockRenderer);
  });

  it('should mention the mapped receiver when bot id is known', async () => {
    const botImId = '1688855974513959';

    const success = await service.notify({
      botImId,
      alertLabel: '已提出到岗问题',
      reason: '候选人开始询问到岗安排',
      chatId: 'chat-123',
      pausedUserId: 'chat-123',
      contactName: '张三',
      currentMessageContent: '我什么时候可以去上岗？',
      recentMessages: [],
      sessionState: null,
      recruitmentCase: buildRecruitmentCase(),
    });

    expect(success).toBe(true);
    expect(mockRenderer.buildCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atUsers: [BOT_TO_RECEIVER[botImId]],
      }),
    );
    expect(mockPrivateChatChannel.send).toHaveBeenCalledWith({
      kind: 'onboard-followup-card',
    });
  });

  it('should fallback to atAll when no bot mapping exists', async () => {
    await service.notify({
      alertLabel: '已转人工对接',
      reason: '候选人要求人工跟进',
      chatId: 'chat-234',
      pausedUserId: 'chat-234',
      contactName: '李四',
      currentMessageContent: '麻烦安排一下入职',
      recentMessages: [],
      sessionState: null,
      recruitmentCase: buildRecruitmentCase(),
    });

    expect(mockRenderer.buildCard).toHaveBeenCalledWith(
      expect.objectContaining({
        atAll: true,
      }),
    );
  });
});

function buildRecruitmentCase(): RecruitmentCaseRecord {
  return {
    id: 'case-1',
    corp_id: 'corp-1',
    chat_id: 'chat-1',
    user_id: 'user-1',
    case_type: 'onboard_followup',
    status: 'handoff',
    booking_id: 'booking-1',
    booked_at: '2026-04-15T08:00:00.000Z',
    interview_time: '2026-04-16 14:00:00',
    job_id: 123,
    job_name: '店员',
    brand_name: '瑞幸',
    store_name: '陆家嘴店',
    bot_im_id: 'bot-im-1',
    followup_window_ends_at: '2026-04-23T06:00:00.000Z',
    last_relevant_at: '2026-04-15T08:00:00.000Z',
    metadata: {},
    created_at: '2026-04-15T08:00:00.000Z',
    updated_at: '2026-04-15T08:00:00.000Z',
  };
}
