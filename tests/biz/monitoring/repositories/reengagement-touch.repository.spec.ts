import { Test, TestingModule } from '@nestjs/testing';
import { ReengagementTouchRepository } from '@biz/monitoring/repositories/reengagement-touch.repository';
import { ReengagementTouchStatus } from '@biz/monitoring/entities/reengagement-touch.entity';
import { SupabaseService } from '@infra/supabase/supabase.service';

function makeQueryMock(result: { data?: unknown; error?: unknown }) {
  const chainMethods = ['select', 'eq', 'gte', 'lte', 'order', 'range', 'limit'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock: any = Object.assign(Promise.resolve(result), {});
  for (const method of chainMethods) {
    mock[method] = jest.fn().mockReturnValue(mock);
  }
  return mock;
}

describe('ReengagementTouchRepository', () => {
  let repository: ReengagementTouchRepository;

  const mockSupabaseClient = {
    from: jest.fn(),
    rpc: jest.fn(),
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockSupabaseClient),
    isClientInitialized: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    mockSupabaseService.isClientInitialized.mockReturnValue(true);
    mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReengagementTouchRepository,
        { provide: SupabaseService, useValue: mockSupabaseService },
      ],
    }).compile();

    repository = module.get<ReengagementTouchRepository>(ReengagementTouchRepository);
  });

  it('records touch lifecycle events through the atomic RPC with normalized timestamps', async () => {
    const ok = await repository.record({
      touchKey: 'sess-1:opening_no_reply:evt-1',
      sessionId: 'sess-1',
      userId: 'user-1',
      corpId: 'corp-1',
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt: Date.UTC(2026, 6, 6, 1, 0, 0),
      jobId: 'job-1',
      status: ReengagementTouchStatus.Sent,
      decisionReason: 'reserved',
      shadow: false,
      fireAt: Date.UTC(2026, 6, 6, 2, 0, 0),
      scheduledAt: Date.UTC(2026, 6, 6, 1, 30, 0),
      firedAt: Date.UTC(2026, 6, 6, 2, 0, 1),
      sentAt: Date.UTC(2026, 6, 6, 2, 0, 2),
      outcomeKind: 'reply',
      generatedText: '还想继续看看吗？',
      reserveResult: 'reserved',
      event: { event: 'sent', detail: { idempotencyKey: 'touch-slot-1' } },
    });

    expect(ok).toBe(true);
    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
      'record_reengagement_touch',
      expect.objectContaining({
        p_touch_key: 'sess-1:opening_no_reply:evt-1',
        p_session_id: 'sess-1',
        p_user_id: 'user-1',
        p_corp_id: 'corp-1',
        p_scenario_code: 'opening_no_reply',
        p_anchor_event_id: 'evt-1',
        p_anchor_at: '2026-07-06T01:00:00.000Z',
        p_job_id: 'job-1',
        p_status: 'sent',
        p_decision_reason: 'reserved',
        p_shadow: false,
        p_fire_at: '2026-07-06T02:00:00.000Z',
        p_scheduled_at: '2026-07-06T01:30:00.000Z',
        p_fired_at: '2026-07-06T02:00:01.000Z',
        p_sent_at: '2026-07-06T02:00:02.000Z',
        p_outcome_kind: 'reply',
        p_generated_text: '还想继续看看吗？',
        p_reserve_result: 'reserved',
        p_error: null,
        p_event: expect.objectContaining({
          event: 'sent',
          detail: { idempotencyKey: 'touch-slot-1' },
        }),
      }),
    );
  });

  it('skips writes when Supabase is unavailable', async () => {
    mockSupabaseService.isClientInitialized.mockReturnValue(false);

    const ok = await repository.record({ touchKey: 'touch-1' });

    expect(ok).toBe(false);
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
  });

  it('queries summary records with filters and without heavy detail columns', async () => {
    const queryMock = makeQueryMock({ data: [{ touch_key: 'touch-1' }], error: null });
    mockSupabaseClient.from.mockReturnValue(queryMock);

    const rows = await repository.getRecords({
      startDate: '2026-07-06T00:00:00.000Z',
      endDate: '2026-07-06T23:59:59.999Z',
      status: ReengagementTouchStatus.Scheduled,
      scenarioCode: 'opening_no_reply',
      sessionId: 'sess-1',
      limit: 500,
      offset: 20,
    });

    expect(rows).toEqual([{ touch_key: 'touch-1' }]);
    expect(mockSupabaseClient.from).toHaveBeenCalledWith('reengagement_touch_records');
    expect(queryMock.select).toHaveBeenCalledWith(expect.not.stringContaining('generated_text'));
    expect(queryMock.select).toHaveBeenCalledWith(expect.not.stringContaining('events'));
    expect(queryMock.gte).toHaveBeenCalledWith('created_at', '2026-07-06T00:00:00.000Z');
    expect(queryMock.lte).toHaveBeenCalledWith('created_at', '2026-07-06T23:59:59.999Z');
    expect(queryMock.eq).toHaveBeenCalledWith('status', 'scheduled');
    expect(queryMock.eq).toHaveBeenCalledWith('scenario_code', 'opening_no_reply');
    expect(queryMock.eq).toHaveBeenCalledWith('session_id', 'sess-1');
    expect(queryMock.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(queryMock.range).toHaveBeenCalledWith(20, 219);
  });

  it('fetches detail records by touch key including the full projection', async () => {
    const queryMock = makeQueryMock({ data: [{ touch_key: 'touch-1', events: [] }], error: null });
    mockSupabaseClient.from.mockReturnValue(queryMock);

    const row = await repository.getRecordByTouchKey('touch-1');

    expect(row).toEqual({ touch_key: 'touch-1', events: [] });
    expect(queryMock.select).toHaveBeenCalledWith('*');
    expect(queryMock.eq).toHaveBeenCalledWith('touch_key', 'touch-1');
  });

  it('resolves runtime channel identity from recent chat messages without taking bot-side contact id', async () => {
    const queryMock = makeQueryMock({
      data: [
        {
          candidate_name: '张三',
          manager_name: 'bot-user-1',
          im_bot_id: 'bot-1',
          im_contact_id: 'bot-contact',
          external_user_id: null,
          is_self: true,
        },
        {
          candidate_name: '张三',
          manager_name: 'bot-user-1',
          im_bot_id: 'bot-1',
          im_contact_id: 'candidate-contact',
          external_user_id: 'external-1',
          is_self: false,
        },
      ],
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(queryMock);

    const identity = await repository.getLatestChatChannelIdentity('sess-1');

    expect(identity).toEqual({
      candidateName: '张三',
      managerName: 'bot-user-1',
      botImId: 'bot-1',
      imContactId: 'candidate-contact',
      externalUserId: 'external-1',
    });
    expect(queryMock.select).toHaveBeenCalledWith(
      'candidate_name,manager_name,im_bot_id,im_contact_id,external_user_id,is_self',
    );
    expect(queryMock.limit).toHaveBeenCalledWith(20);
  });

  it('delegates stats and candidate overview to RPCs with capped pagination', async () => {
    mockSupabaseClient.rpc
      .mockResolvedValueOnce({
        data: [{ status: 'sent', scenario_code: 'opening_no_reply', cnt: 2 }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ session_id: 'sess-1', total_sessions: 1 }], error: null });

    const stats = await repository.getStats('2026-07-06T00:00:00.000Z', '2026-07-06T23:59:59.999Z');
    const candidates = await repository.getCandidateOverview({
      startDate: '2026-07-06T00:00:00.000Z',
      endDate: '2026-07-06T23:59:59.999Z',
      scenarioCode: 'opening_no_reply',
      keyword: '候选人A',
      pendingOnly: true,
      limit: 999,
      offset: 10,
    });

    expect(stats).toEqual([{ status: 'sent', scenario_code: 'opening_no_reply', cnt: 2 }]);
    expect(candidates).toEqual([{ session_id: 'sess-1', total_sessions: 1 }]);
    expect(mockSupabaseClient.rpc).toHaveBeenNthCalledWith(1, 'get_reengagement_touch_stats', {
      p_start: '2026-07-06T00:00:00.000Z',
      p_end: '2026-07-06T23:59:59.999Z',
    });
    expect(mockSupabaseClient.rpc).toHaveBeenNthCalledWith(
      2,
      'get_reengagement_candidate_overview',
      {
        p_start: '2026-07-06T00:00:00.000Z',
        p_end: '2026-07-06T23:59:59.999Z',
        p_scenario_code: 'opening_no_reply',
        p_keyword: '候选人A',
        p_pending_only: true,
        p_limit: 200,
        p_offset: 10,
      },
    );
  });
});
