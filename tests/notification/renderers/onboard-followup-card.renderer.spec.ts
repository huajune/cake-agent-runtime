import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { OnboardFollowupCardRenderer } from '@notification/renderers/onboard-followup-card.renderer';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';

describe('OnboardFollowupCardRenderer', () => {
  let renderer: OnboardFollowupCardRenderer;
  let cardBuilder: jest.Mocked<FeishuCardBuilderService>;

  beforeEach(() => {
    cardBuilder = {
      buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
    } as unknown as jest.Mocked<FeishuCardBuilderService>;

    renderer = new OnboardFollowupCardRenderer(cardBuilder);
  });

  it('should render wechat nickname and bot user name', () => {
    const card = renderer.buildCard({
      alertLabel: '到店无人接待',
      reason: '候选人到店后无人接待或联系不上负责人，需要人工介入协调',
      botImId: 'bot-im-1',
      botUserName: '招募经理A',
      contactName: 'wx_candidate',
      chatId: 'chat-123',
      pausedUserId: 'chat-123',
      currentMessageContent: '我到店了，但是没人接待',
      recentMessages: [{ role: 'user', content: '我到店了，但是没人接待', timestamp: 1712044860000 }],
      sessionState: {
        facts: {
          interview_info: {
            name: '张三',
            phone: '13800000000',
            gender: '男',
            age: '23',
            applied_store: null,
            applied_position: null,
            interview_time: null,
            is_student: null,
            education: null,
            has_health_certificate: null,
          },
          preferences: {
            brands: null,
            salary: null,
            position: null,
            schedule: null,
            city: null,
            district: null,
            location: null,
            labor_form: null,
          },
          reasoning: 'test',
        },
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: null,
        invitedGroups: null,
      },
      recruitmentCase: buildRecruitmentCase(),
    });

    expect(card).toEqual(
      expect.objectContaining({
        title: '🚨 面试及上岗对接 · 需要人工介入',
        color: 'red',
      }),
    );
    expect((card.content as string)).toContain('微信昵称：wx_candidate');
    expect((card.content as string)).toContain('姓名：张三');
    expect((card.content as string)).toContain('托管账号：招募经理A');
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
