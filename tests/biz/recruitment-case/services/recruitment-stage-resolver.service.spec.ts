import { RecruitmentStageResolverService } from '@biz/recruitment-case/services/recruitment-stage-resolver.service';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';

describe('RecruitmentStageResolverService', () => {
  const service = new RecruitmentStageResolverService();

  const activeCase: RecruitmentCaseRecord = {
    id: 'case-1',
    corp_id: 'corp-1',
    chat_id: 'chat-1',
    user_id: 'user-1',
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

  it('should prefer onboard_followup when an active case exists', () => {
    expect(
      service.resolve({
        proceduralStage: 'job_consultation',
        recruitmentCase: activeCase,
        currentMessageContent: '我到店了',
      }),
    ).toBe('onboard_followup');
  });

  it('should fall back to procedural stage for obvious new job consultation', () => {
    expect(
      service.resolve({
        proceduralStage: 'job_consultation',
        recruitmentCase: activeCase,
        currentMessageContent: '还有其他岗位吗',
      }),
    ).toBe('job_consultation');
  });

  it('should default to active case even for short ambiguous follow-up pings', () => {
    expect(
      service.resolve({
        proceduralStage: 'job_consultation',
        recruitmentCase: activeCase,
        currentMessageContent: '在吗',
      }),
    ).toBe('onboard_followup');
  });
});

