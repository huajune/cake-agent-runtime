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
      getStatsByDecisionReasons: jest.fn().mockResolvedValue([]),
      getWeeklyFunnel: jest.fn().mockResolvedValue([]),
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

  it('drops non-numeric or non-positive pagination params so repository defaults apply', async () => {
    repository.getRecords.mockResolvedValue([]);

    // limit='abc' → NaN 不得穿透到 .range()；offset='-5' → 回落 Repository 默认 0
    await service.getRecords({ limit: 'abc', offset: '-5' });

    expect(repository.getRecords).toHaveBeenCalledWith({});
  });

  it('drops non-enum status instead of passing arbitrary strings to PostgREST', async () => {
    repository.getRecords.mockResolvedValue([]);

    await service.getRecords({ status: 'not-a-status' });

    expect(repository.getRecords).toHaveBeenCalledWith({});
  });

  it('keeps valid pagination while dropping only the invalid param', async () => {
    repository.getRecords.mockResolvedValue([]);

    await service.getRecords({ limit: '25', offset: 'abc' });

    expect(repository.getRecords).toHaveBeenCalledWith({ limit: 25 });
  });

  it('sanitizes candidate overview pagination the same way', async () => {
    repository.getCandidateOverview.mockResolvedValue([]);

    await service.getCandidateOverview({ limit: 'abc', offset: '-5' });

    expect(repository.getCandidateOverview).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined, offset: undefined }),
    );
  });

  describe('weekly funnel（登记 → 发出 → 6h 回复）', () => {
    it('merges scenarios into weekly buckets and derives the 6h reply rate', async () => {
      repository.getWeeklyFunnel.mockResolvedValue([
        {
          week_start: '2026-09-07',
          scenario_code: 'interview_reminder',
          registered: 10,
          sent: 6,
          replied_6h: 3,
        },
        {
          week_start: '2026-09-07',
          scenario_code: 'opening_no_reply',
          registered: 20,
          sent: 14,
          replied_6h: 2,
        },
        {
          week_start: '2026-09-14',
          scenario_code: 'opening_no_reply',
          registered: 5,
          sent: 0,
          replied_6h: 0,
        },
      ]);

      const buckets = await service.getWeeklyFunnel('2026-09-07', '2026-09-20');

      expect(repository.getWeeklyFunnel).toHaveBeenCalledWith(
        '2026-09-06T16:00:00.000Z',
        '2026-09-20T16:00:00.000Z',
      );
      expect(buckets).toEqual([
        { weekStart: '2026-09-07', registered: 30, sent: 20, replied6h: 5, replyRate: 0.25 },
        { weekStart: '2026-09-14', registered: 5, sent: 0, replied6h: 0, replyRate: null },
      ]);
    });

    it('caps the range to the most recent 13 weeks so the RPC never scans the whole table', async () => {
      await service.getWeeklyFunnel('2025-01-01', '2026-09-20');

      // 13 周 = 91 天：2026-09-20 往前 90 天 = 2026-06-22（上海日界）
      expect(repository.getWeeklyFunnel).toHaveBeenCalledWith(
        '2026-06-21T16:00:00.000Z',
        '2026-09-20T16:00:00.000Z',
      );
    });

    it('caches by (start, end) for 10 minutes so Dashboard refreshes do not re-run the RPC', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-21T00:00:00Z'));
      repository.getWeeklyFunnel.mockResolvedValue([
        {
          week_start: '2026-09-14',
          scenario_code: 'opening_no_reply',
          registered: 1,
          sent: 1,
          replied_6h: 0,
        },
      ]);

      const first = await service.getWeeklyFunnel('2026-09-07', '2026-09-20');
      const second = await service.getWeeklyFunnel('2026-09-07', '2026-09-20');
      // 不同范围是独立缓存键
      await service.getWeeklyFunnel('2026-09-14', '2026-09-20');

      expect(second).toEqual(first);
      expect(repository.getWeeklyFunnel).toHaveBeenCalledTimes(2);

      // 超过 TTL 后重新拉
      nowSpy.mockReturnValue(Date.parse('2026-09-21T00:10:01Z'));
      await service.getWeeklyFunnel('2026-09-07', '2026-09-20');
      expect(repository.getWeeklyFunnel).toHaveBeenCalledTimes(3);
      nowSpy.mockRestore();
    });

    it('does not cache a failed load, so the next call retries the RPC', async () => {
      repository.getWeeklyFunnel
        .mockRejectedValueOnce(new Error('rpc timeout'))
        .mockResolvedValueOnce([]);

      await expect(service.getWeeklyFunnel('2026-09-07', '2026-09-20')).rejects.toThrow(
        'rpc timeout',
      );
      await expect(service.getWeeklyFunnel('2026-09-07', '2026-09-20')).resolves.toEqual([]);
      expect(repository.getWeeklyFunnel).toHaveBeenCalledTimes(2);
    });
  });

  it('caps stats to the most recent 13 weeks (same rule as the weekly funnel)', async () => {
    repository.getStats.mockResolvedValue([]);

    await service.getStats('2025-01-01', '2026-09-20');

    expect(repository.getStats).toHaveBeenCalledWith(
      '2026-06-21T16:00:00.000Z',
      '2026-09-20T15:59:59.999Z',
    );
    expect(repository.getStatsByDecisionReasons).toHaveBeenCalledWith(
      '2026-06-21T16:00:00.000Z',
      '2026-09-20T15:59:59.999Z',
      ['signup_interview_gap_lt_3d'],
    );
  });

  it('queries stats using the same local-day boundary convention', async () => {
    repository.getStats.mockResolvedValue([]);

    await service.getStats('2026-07-06', '2026-07-07');

    expect(repository.getStats).toHaveBeenCalledWith(
      '2026-07-05T16:00:00.000Z',
      '2026-07-07T15:59:59.999Z',
    );
    expect(repository.getStatsByDecisionReasons).toHaveBeenCalledWith(
      '2026-07-05T16:00:00.000Z',
      '2026-07-07T15:59:59.999Z',
      ['signup_interview_gap_lt_3d'],
    );
  });

  it('excludes signup_interview_gap_lt_3d records from the grouped stats (总触达口径)', async () => {
    repository.getStats.mockResolvedValue([
      { status: 'sent', scenario_code: 'interview_reminder', cnt: 10 },
      { status: 'skipped', scenario_code: 'interview_reminder', cnt: 5 },
      { status: 'stopped', scenario_code: 'interview_reminder', cnt: 2 },
      { status: 'sent', scenario_code: 'opening_no_reply', cnt: 7 },
    ]);
    repository.getStatsByDecisionReasons.mockResolvedValue([
      { status: 'skipped', scenario_code: 'interview_reminder', cnt: 3 },
      { status: 'stopped', scenario_code: 'interview_reminder', cnt: 2 },
    ]);

    const rows = await service.getStats('2026-07-06', '2026-07-07');

    // skipped 5-3=2 保留；stopped 2-2=0 整桶去掉；其余不动
    expect(rows).toEqual([
      { status: 'sent', scenario_code: 'interview_reminder', cnt: 10 },
      { status: 'skipped', scenario_code: 'interview_reminder', cnt: 2 },
      { status: 'sent', scenario_code: 'opening_no_reply', cnt: 7 },
    ]);
  });

  it('falls back to the raw grouped stats when the exclusion query fails', async () => {
    const raw = [{ status: 'sent', scenario_code: 'interview_reminder', cnt: 10 }];
    repository.getStats.mockResolvedValue(raw);
    repository.getStatsByDecisionReasons.mockRejectedValue(new Error('db timeout'));

    await expect(service.getStats('2026-07-06', '2026-07-07')).resolves.toEqual(raw);
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
        status: 'scheduled',
        decision_reason: null,
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
      keyword: '  候选人A  ',
      pendingOnly: 'true',
      limit: '20',
      offset: '40',
    });

    expect(repository.getCandidateOverview).toHaveBeenCalledWith({
      startDate: '2026-07-05T16:00:00.000Z',
      endDate: '2026-07-06T15:59:59.999Z',
      scenarioCode: 'opening_no_reply',
      keyword: '候选人A',
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

  it('hides superseded rows from candidate overview current states', async () => {
    repository.getCandidateOverview.mockResolvedValue([
      {
        session_id: 'sess-1',
        user_id: 'user-1',
        corp_id: 'corp-1',
        scenario_code: 'opening_no_reply',
        touch_key: 'old-touch',
        status: 'superseded',
        decision_reason: 'superseded_by_new_task',
        shadow: false,
        fire_at: '2026-07-06T08:00:00.000Z',
        sent_at: null,
        anchor_at: '2026-07-06T01:00:00.000Z',
        outcome_kind: null,
        updated_at: '2026-07-06T05:00:00.000Z',
        session_latest_at: '2026-07-06T06:00:00.000Z',
        total_sessions: 1,
        candidate_name: '候选人A',
        manager_name: '招聘顾问一号',
        bot_im_id: 'bot-1',
      },
      {
        session_id: 'sess-1',
        user_id: 'user-1',
        corp_id: 'corp-1',
        scenario_code: 'booking_incomplete',
        touch_key: 'new-touch',
        status: 'scheduled',
        decision_reason: null,
        shadow: false,
        fire_at: '2026-07-06T09:00:00.000Z',
        sent_at: null,
        anchor_at: '2026-07-06T02:00:00.000Z',
        outcome_kind: null,
        updated_at: '2026-07-06T06:00:00.000Z',
        session_latest_at: '2026-07-06T06:00:00.000Z',
        total_sessions: 1,
        candidate_name: '候选人A',
        manager_name: '招聘顾问一号',
        bot_im_id: 'bot-1',
      },
    ]);

    const result = await service.getCandidateOverview({});

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].scenarios).toHaveLength(1);
    expect(result.candidates[0].scenarios[0].touchKey).toBe('new-touch');
  });

  it('returns an empty candidate page when the RPC returns no rows', async () => {
    repository.getCandidateOverview.mockResolvedValue([]);

    const result = await service.getCandidateOverview({});

    expect(result).toEqual({ total: 0, candidates: [] });
  });
});
