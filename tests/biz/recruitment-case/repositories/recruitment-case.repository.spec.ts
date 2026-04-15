import { RecruitmentCaseRepository } from '@biz/recruitment-case/repositories/recruitment-case.repository';
import { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';

describe('RecruitmentCaseRepository', () => {
  let repository: RecruitmentCaseRepository;

  beforeEach(() => {
    repository = new RecruitmentCaseRepository({} as never);
  });

  it('should query chat and user handoff cases separately without using or filters', async () => {
    const selectOneSpy = jest
      .spyOn(repository as any, 'selectOne')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await repository.findLatestHandoffByTarget('target-123');

    expect(selectOneSpy).toHaveBeenCalledTimes(2);

    const buildQuery = () => ({
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
    });

    const chatQuery = buildQuery();
    const userQuery = buildQuery();

    const chatModifier = selectOneSpy.mock.calls[0][1] as (query: typeof chatQuery) => void;
    const userModifier = selectOneSpy.mock.calls[1][1] as (query: typeof userQuery) => void;

    chatModifier(chatQuery);
    userModifier(userQuery);

    expect(chatQuery.eq).toHaveBeenNthCalledWith(1, 'case_type', 'onboard_followup');
    expect(chatQuery.eq).toHaveBeenNthCalledWith(2, 'status', 'handoff');
    expect(chatQuery.eq).toHaveBeenNthCalledWith(3, 'chat_id', 'target-123');
    expect(chatQuery.order).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(chatQuery.or).not.toHaveBeenCalled();

    expect(userQuery.eq).toHaveBeenNthCalledWith(1, 'case_type', 'onboard_followup');
    expect(userQuery.eq).toHaveBeenNthCalledWith(2, 'status', 'handoff');
    expect(userQuery.eq).toHaveBeenNthCalledWith(3, 'user_id', 'target-123');
    expect(userQuery.order).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(userQuery.or).not.toHaveBeenCalled();
  });

  it('should return the most recently updated handoff match across chat and user ids', async () => {
    const olderCase = buildCase('case-chat', '2026-04-15T10:00:00.000Z');
    const newerCase = buildCase('case-user', '2026-04-15T11:00:00.000Z');

    jest
      .spyOn(repository as any, 'selectOne')
      .mockResolvedValueOnce(olderCase)
      .mockResolvedValueOnce(newerCase);

    await expect(repository.findLatestHandoffByTarget('target-123')).resolves.toEqual(newerCase);
  });

  it('should return whichever handoff match exists when only one query finds a record', async () => {
    const handoffCase = buildCase('case-chat', '2026-04-15T10:00:00.000Z');

    jest
      .spyOn(repository as any, 'selectOne')
      .mockResolvedValueOnce(handoffCase)
      .mockResolvedValueOnce(null);

    await expect(repository.findLatestHandoffByTarget('target-123')).resolves.toEqual(handoffCase);
  });
});

function buildCase(id: string, updatedAt: string): RecruitmentCaseRecord {
  return {
    id,
    corp_id: 'corp-1',
    chat_id: 'chat-1',
    user_id: 'user-1',
    case_type: 'onboard_followup',
    status: 'handoff',
    booking_id: 'booking-1',
    booked_at: updatedAt,
    interview_time: '2026-04-20 10:00:00',
    job_id: 1,
    job_name: '店员',
    brand_name: '品牌',
    store_name: '门店',
    bot_im_id: 'bot-im-1',
    followup_window_ends_at: '2026-04-22T10:00:00.000Z',
    last_relevant_at: updatedAt,
    metadata: {},
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}
