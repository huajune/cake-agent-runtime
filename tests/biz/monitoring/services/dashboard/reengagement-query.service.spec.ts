import { ReengagementQueryService } from '@biz/monitoring/services/dashboard/reengagement-query.service';
import { ReengagementTouchRepository } from '@biz/monitoring/repositories/reengagement-touch.repository';
import type { ReengagementCandidateOverviewRow } from '@biz/monitoring/entities/reengagement-touch.entity';

describe('ReengagementQueryService', () => {
  let repository: jest.Mocked<ReengagementTouchRepository>;
  let service: ReengagementQueryService;

  beforeEach(() => {
    repository = {
      getRecords: jest.fn(),
      getRecordByTouchKey: jest.fn(),
      getStats: jest.fn(),
      getCandidateOverview: jest.fn(),
    } as unknown as jest.Mocked<ReengagementTouchRepository>;
    service = new ReengagementQueryService(repository);
  });

  it('normalizes list filters with Asia/Shanghai day boundaries', async () => {
    repository.getRecords.mockResolvedValue([]);

    await service.getRecords({
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      status: 'scheduled',
      scenarioCode: 'opening_no_reply',
      sessionId: 'sess-1',
      limit: '25',
      offset: '50',
    });

    expect(repository.getRecords).toHaveBeenCalledWith({
      startDate: '2026-07-05T16:00:00.000Z',
      endDate: '2026-07-06T15:59:59.999Z',
      status: 'scheduled',
      scenarioCode: 'opening_no_reply',
      sessionId: 'sess-1',
      limit: 25,
      offset: 50,
    });
  });

  it('queries stats using the same local-day boundary convention', async () => {
    repository.getStats.mockResolvedValue([]);

    await service.getStats('2026-07-06', '2026-07-07');

    expect(repository.getStats).toHaveBeenCalledWith(
      '2026-07-05T16:00:00.000Z',
      '2026-07-07T15:59:59.999Z',
    );
  });

  it('delegates detail lookup by touch key', async () => {
    repository.getRecordByTouchKey.mockResolvedValue({ touch_key: 'touch-1' } as never);

    const result = await service.getRecordByTouchKey('touch-1');

    expect(result).toEqual({ touch_key: 'touch-1' });
    expect(repository.getRecordByTouchKey).toHaveBeenCalledWith('touch-1');
  });

  it('groups candidate overview rows by session and derives the nearest future touch', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-06T06:00:00.000Z'));
    const rows: ReengagementCandidateOverviewRow[] = [
      {
        session_id: 'sess-1',
        user_id: 'user-1',
        corp_id: 'corp-1',
        scenario_code: 'opening_no_reply',
        touch_key: 'touch-1',
        status: 'scheduled',
        decision_reason: null,
        shadow: false,
        fire_at: '2026-07-06T08:00:00.000Z',
        sent_at: null,
        anchor_at: '2026-07-06T01:00:00.000Z',
        outcome_kind: null,
        updated_at: '2026-07-06T05:00:00.000Z',
        session_latest_at: '2026-07-06T05:00:00.000Z',
        total_sessions: 2,
        candidate_name: '候选人A',
        manager_name: '招聘顾问一号',
        bot_im_id: 'bot-1',
      },
      {
        session_id: 'sess-1',
        user_id: 'user-1',
        corp_id: 'corp-1',
        scenario_code: 'interview_reminder',
        touch_key: 'touch-2',
        status: 'rescheduled',
        decision_reason: 'outside_send_window',
        shadow: false,
        fire_at: '2026-07-06T07:00:00.000Z',
        sent_at: null,
        anchor_at: '2026-07-06T02:00:00.000Z',
        outcome_kind: null,
        updated_at: '2026-07-06T05:30:00.000Z',
        session_latest_at: '2026-07-06T05:30:00.000Z',
        total_sessions: 2,
        candidate_name: '候选人A',
        manager_name: '招聘顾问一号',
        bot_im_id: 'bot-1',
      },
      {
        session_id: 'sess-2',
        user_id: 'user-2',
        corp_id: 'corp-2',
        scenario_code: 'post_interview_no_feedback',
        touch_key: 'touch-3',
        status: 'sent',
        decision_reason: null,
        shadow: false,
        fire_at: '2026-07-06T04:00:00.000Z',
        sent_at: '2026-07-06T04:00:10.000Z',
        anchor_at: '2026-07-06T01:00:00.000Z',
        outcome_kind: 'reply',
        updated_at: '2026-07-06T04:00:10.000Z',
        session_latest_at: '2026-07-06T04:00:10.000Z',
        total_sessions: 2,
        candidate_name: null,
        manager_name: null,
        bot_im_id: null,
      },
    ];
    repository.getCandidateOverview.mockResolvedValue(rows);

    const result = await service.getCandidateOverview({
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      scenarioCode: 'opening_no_reply',
      sessionId: 'sess-1',
      pendingOnly: 'true',
      limit: '20',
      offset: '40',
    });

    expect(repository.getCandidateOverview).toHaveBeenCalledWith({
      startDate: '2026-07-05T16:00:00.000Z',
      endDate: '2026-07-06T15:59:59.999Z',
      scenarioCode: 'opening_no_reply',
      sessionId: 'sess-1',
      pendingOnly: true,
      limit: 20,
      offset: 40,
    });
    expect(result.total).toBe(2);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        sessionId: 'sess-1',
        userId: 'user-1',
        corpId: 'corp-1',
        candidateName: '候选人A',
        managerName: '招聘顾问一号',
        botImId: 'bot-1',
        nextTouch: {
          scenarioCode: 'interview_reminder',
          touchKey: 'touch-2',
          fireAt: '2026-07-06T07:00:00.000Z',
        },
      }),
    );
    expect(result.candidates[0].scenarios).toHaveLength(2);
    expect(result.candidates[1].nextTouch).toBeNull();
  });

  it('returns an empty candidate page when the RPC returns no rows', async () => {
    repository.getCandidateOverview.mockResolvedValue([]);

    const result = await service.getCandidateOverview({});

    expect(result).toEqual({ total: 0, candidates: [] });
  });
});
