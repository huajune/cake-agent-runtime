import { GuardrailReviewRepository } from '@biz/message/repositories/guardrail-review.repository';
import type { GuardrailReviewInsertInput } from '@biz/message/types/guardrail-review.types';
import { SupabaseService } from '@infra/supabase/supabase.service';

type UpsertOptions = { onConflict?: string; ignoreDuplicates?: boolean };
type SelectMock = jest.Mock<Promise<{ data: unknown[] | null; error: unknown }>, [string]>;
type UpsertMock = jest.Mock<{ select: SelectMock }, [Record<string, unknown>, UpsertOptions]>;
type ClientMock = {
  from: jest.Mock<{ upsert: UpsertMock }, [string]>;
};
type RepositoryWithClient = GuardrailReviewRepository & {
  getClient(): ClientMock;
};
type RepositoryWithSelectOne = GuardrailReviewRepository & {
  selectOne: jest.Mock;
};
describe('GuardrailReviewRepository', () => {
  const repository = new GuardrailReviewRepository({
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn().mockReturnValue(true),
  } as unknown as SupabaseService);

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  function mockClient(response: { data: unknown[] | null; error: unknown }) {
    const select = jest.fn<Promise<{ data: unknown[] | null; error: unknown }>, [string]>();
    select.mockResolvedValue(response);
    const upsert = jest.fn<{ select: SelectMock }, [Record<string, unknown>, UpsertOptions]>();
    upsert.mockReturnValue({ select });
    const from = jest.fn<{ upsert: UpsertMock }, [string]>();
    from.mockReturnValue({ upsert });
    jest.spyOn(repository as RepositoryWithClient, 'getClient').mockReturnValue({ from });
    return { from, upsert, select };
  }

  const baseRecord: GuardrailReviewInsertInput = {
    traceId: 'msg-1',
    chatId: 'chat-1',
    firstReply: '首版回复',
    first: {
      decision: 'repair' as const,
      riskLevel: 'medium' as const,
      ruleIds: ['job_detail_lookup_required'],
      blockedRuleIds: ['job_detail_lookup_required'],
      violations: [{ type: 'bad_fact', evidence: 'x', suggestion: 'y' }],
      feedback: '不要给区级距离结论',
    },
    repairMode: 'rewrite',
    repaired: true,
    revisedReply: '重写回复',
    revised: {
      decision: 'pass' as const,
      riskLevel: 'low' as const,
      ruleIds: [],
      blockedRuleIds: [],
      violations: [],
    },
    finalOutcome: 'reply' as const,
  };

  it('upserts review records by trace_id and returns inserted', async () => {
    const { upsert } = mockClient({ data: [{ trace_id: 'msg-1' }], error: null });

    await expect(repository.insertReviewRecord(baseRecord)).resolves.toBe('inserted');

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'msg-1',
        chat_id: 'chat-1',
        first_reply: '首版回复',
        first_decision: 'repair',
        first_rule_ids: ['job_detail_lookup_required'],
        first_feedback: '不要给区级距离结论',
        repaired: true,
        revised_reply: '重写回复',
        revised_decision: 'pass',
        final_decision: 'reply',
      }),
      { onConflict: 'trace_id', ignoreDuplicates: false },
    );
    expect(upsert.mock.calls[0][0]).not.toHaveProperty('semantic_reviews');
  });

  it('persists an empty repair without fabricating a second review or overwriting semantic history', async () => {
    const { upsert } = mockClient({ data: [{ trace_id: 'msg-1' }], error: null });
    await repository.insertReviewRecord({
      ...baseRecord,
      finalOutcome: 'handoff',
      revisedReply: '',
      revised: undefined,
    });
    expect(upsert.mock.calls[0][0]).toMatchObject({
      repaired: true,
      revised_reply: '',
      revised_decision: null,
      final_decision: 'handoff',
      first_decision: 'repair',
    });
    expect(upsert.mock.calls[0][0]).not.toHaveProperty('semantic_reviews');
  });

  it.each([
    ['repair_exhausted', undefined, 'block'],
    ['meta_narration_silenced', 'skipped', undefined],
    ['meta_narration_silenced|override:meta_narration_reply:repair', 'skipped', undefined],
  ])(
    'keeps historical block attribution distinct for %s, even after repair',
    async (reasonCode, finalOutcome, legacyFinalDecision) => {
      jest.spyOn(repository as unknown as RepositoryWithSelectOne, 'selectOne').mockResolvedValue({
        trace_id: 'legacy',
        first_reply: '首版',
        first_decision: 'block',
        repaired: true,
        revised_reply: '',
        revised_decision: null,
        final_decision: 'block',
        reason_code: reasonCode,
        semantic_reviews: [
          {
            mode: 'shadow',
            decision: 'block',
            findings: [],
            draftReply: '历史语义草稿',
            confidence: 'high',
          },
        ],
      });
      const review = await repository.findByTraceId('legacy');
      expect(review).toMatchObject({ repaired: true, revisedReply: '', finalOutcome });
      expect(review?.legacyFinalDecision).toBe(legacyFinalDecision);
      expect(review?.semanticReviews).toEqual([
        expect.objectContaining({ draftReply: '历史语义草稿', decision: 'repair' }),
      ]);
    },
  );

  it('returns failed when an upsert unexpectedly returns no row', async () => {
    mockClient({ data: [], error: null });

    await expect(repository.insertReviewRecord(baseRecord)).resolves.toBe('failed');
  });

  it('returns failed when the database write fails', async () => {
    mockClient({ data: null, error: { message: 'db unavailable' } });

    await expect(repository.insertReviewRecord(baseRecord)).resolves.toBe('failed');
  });

  it('maps database rows when finding a review by trace_id', async () => {
    const selectOne = jest
      .spyOn(repository as unknown as RepositoryWithSelectOne, 'selectOne')
      .mockResolvedValue({
        trace_id: 'msg-1',
        chat_id: 'chat-1',
        user_id: 'user-1',
        bot_im_id: 'bot-im-1',
        bot_user_name: 'bot',
        contact_name: '候选人',
        user_message: '用户消息',
        first_reply: '首版回复',
        first_decision: 'revise',
        first_risk_level: 'medium',
        first_rule_ids: ['job_detail_lookup_required'],
        first_blocked_rule_ids: ['job_detail_lookup_required'],
        first_violations: [{ type: 'bad_fact', evidence: 'x', suggestion: 'y' }],
        first_feedback: '不要给区级距离结论',
        repair_mode: 'rewrite',
        repaired: true,
        revised_reply: '重写回复',
        revised_decision: 'pass',
        revised_risk_level: 'low',
        revised_rule_ids: [],
        revised_blocked_rule_ids: [],
        revised_violations: [],
        committed_side_effects: '已成功报名',
        final_decision: 'pass',
        reason_code: 'repair_ok',
        semantic_reviews: [
          {
            mode: 'enforce',
            decision: 'revise',
            confidence: 'high',
            findings: [],
            draftReply: '首版回复',
            reviewedAt: '2026-07-03T08:59:59.000Z',
          },
        ],
        created_at: '2026-07-03T09:00:00.000Z',
      });

    await expect(repository.findByTraceId('msg-1')).resolves.toEqual(
      expect.objectContaining({
        traceId: 'msg-1',
        chatId: 'chat-1',
        userId: 'user-1',
        firstReply: '首版回复',
        first: expect.objectContaining({
          decision: 'repair',
          riskLevel: 'medium',
          ruleIds: ['job_detail_lookup_required'],
          feedback: '不要给区级距离结论',
        }),
        repairMode: 'rewrite',
        repaired: true,
        revisedReply: '重写回复',
        revised: expect.objectContaining({ decision: 'pass', riskLevel: 'low' }),
        committedSideEffects: '已成功报名',
        finalOutcome: 'reply',
        reasonCode: 'repair_ok',
        semanticReviews: [expect.objectContaining({ mode: 'enforce', decision: 'repair' })],
        createdAt: '2026-07-03T09:00:00.000Z',
      }),
    );
    expect(selectOne).toHaveBeenCalledWith('*', expect.any(Function));
  });

  it('returns null when no review row exists for the trace_id', async () => {
    jest
      .spyOn(repository as unknown as RepositoryWithSelectOne, 'selectOne')
      .mockResolvedValue(null);

    await expect(repository.findByTraceId('missing')).resolves.toBeNull();
  });
});
