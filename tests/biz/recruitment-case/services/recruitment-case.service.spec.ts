import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';

describe('RecruitmentCaseService', () => {
  const mockRepository = {
    closeOpenCases: jest.fn(),
    createCase: jest.fn(),
    findLatestByChatAndType: jest.fn(),
    updateStatus: jest.fn(),
    findLatestHandoffByTarget: jest.fn(),
  };
  const mockConfigService = {
    get: jest.fn(),
  };

  let service: RecruitmentCaseService;

  const activeRecord: RecruitmentCaseRecord = {
    id: 'case-1',
    corp_id: 'corp-1',
    chat_id: 'chat-1',
    user_id: 'user-1',
    case_type: 'onboard_followup',
    status: 'active',
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

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RecruitmentCaseService(mockRepository as never, mockConfigService as never);
    mockConfigService.get.mockReturnValue('7');
    mockRepository.createCase.mockResolvedValue(activeRecord);
    mockRepository.updateStatus.mockResolvedValue({ ...activeRecord, status: 'closed' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should close previous cases and create an active onboarding case on booking success', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-15T00:00:00.000Z'));

    await service.openOnBookingSuccess({
      corpId: 'corp-1',
      chatId: 'chat-1',
      userId: 'user-1',
      snapshot: {
        bookingId: 'booking-1',
        interviewTime: '2026-04-16 14:00:00',
        jobId: 123,
        jobName: '店员',
        brandName: '瑞幸',
        storeName: '陆家嘴店',
        botImId: 'bot-im-1',
      },
    });

    expect(mockRepository.closeOpenCases).toHaveBeenCalledWith({
      corpId: 'corp-1',
      chatId: 'chat-1',
      caseType: 'onboard_followup',
    });
    expect(mockRepository.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'corp-1',
        chatId: 'chat-1',
        userId: 'user-1',
        caseType: 'onboard_followup',
        status: 'active',
        lastRelevantAt: '2026-04-15T00:00:00.000Z',
        snapshot: expect.objectContaining({
          bookingId: 'booking-1',
          bookedAt: '2026-04-15T00:00:00.000Z',
          followupWindowEndsAt: '2026-04-23T06:00:00.000Z',
        }),
      }),
    );
  });

  it('should ignore expired active cases', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-30T00:00:00.000Z'));
    mockRepository.findLatestByChatAndType.mockResolvedValue({
      ...activeRecord,
      followup_window_ends_at: '2026-04-20T00:00:00.000Z',
    });

    await expect(
      service.getActiveOnboardFollowupCase({
        corpId: 'corp-1',
        chatId: 'chat-1',
      }),
    ).resolves.toBeNull();
  });

  it('should close the latest handoff case when hosting resumes', async () => {
    mockRepository.findLatestHandoffByTarget.mockResolvedValue({
      ...activeRecord,
      status: 'handoff',
    });

    const result = await service.closeLatestHandoffCase('chat-1');

    expect(mockRepository.findLatestHandoffByTarget).toHaveBeenCalledWith('chat-1');
    expect(mockRepository.updateStatus).toHaveBeenCalledWith('case-1', 'closed');
    expect(result).toEqual({ ...activeRecord, status: 'closed' });
  });
});
