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
      decision: 'revise' as const,
      riskLevel: 'medium' as const,
      ruleIds: ['district_level_distance_claim'],
      blockedRuleIds: ['district_level_distance_claim'],
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
    finalDecision: 'pass' as const,
  };

  it('upserts review records by trace_id and returns inserted', async () => {
    const { upsert } = mockClient({ data: [{ trace_id: 'msg-1' }], error: null });

    await expect(repository.insertReviewRecord(baseRecord)).resolves.toBe('inserted');

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: 'msg-1',
        chat_id: 'chat-1',
        first_reply: '首版回复',
        first_decision: 'revise',
        first_rule_ids: ['district_level_distance_claim'],
        first_feedback: '不要给区级距离结论',
        repaired: true,
        revised_reply: '重写回复',
        revised_decision: 'pass',
        final_decision: 'pass',
      }),
      { onConflict: 'trace_id', ignoreDuplicates: true },
    );
  });

  it('returns duplicate when the trace_id write is skipped by conflict', async () => {
    mockClient({ data: [], error: null });

    await expect(repository.insertReviewRecord(baseRecord)).resolves.toBe('duplicate');
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
        first_rule_ids: ['district_level_distance_claim'],
        first_blocked_rule_ids: ['district_level_distance_claim'],
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
        created_at: '2026-07-03T09:00:00.000Z',
      });

    await expect(repository.findByTraceId('msg-1')).resolves.toEqual(
      expect.objectContaining({
        traceId: 'msg-1',
        chatId: 'chat-1',
        userId: 'user-1',
        firstReply: '首版回复',
        first: expect.objectContaining({
          decision: 'revise',
          riskLevel: 'medium',
          ruleIds: ['district_level_distance_claim'],
          feedback: '不要给区级距离结论',
        }),
        repairMode: 'rewrite',
        repaired: true,
        revisedReply: '重写回复',
        revised: expect.objectContaining({ decision: 'pass', riskLevel: 'low' }),
        committedSideEffects: '已成功报名',
        finalDecision: 'pass',
        reasonCode: 'repair_ok',
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
