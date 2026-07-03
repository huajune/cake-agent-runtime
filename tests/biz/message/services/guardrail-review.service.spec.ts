import { GuardrailReviewRepository } from '@biz/message/repositories/guardrail-review.repository';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import type { GuardrailReviewInsertInput } from '@biz/message/types/guardrail-review.types';

describe('GuardrailReviewService', () => {
  const repository = {
    insertReviewRecord: jest.fn(),
    findByTraceId: jest.fn(),
  };
  const service = new GuardrailReviewService(repository as unknown as GuardrailReviewRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validRecord: GuardrailReviewInsertInput = {
    traceId: 'msg-1',
    firstReply: '首版',
    first: {
      decision: 'revise',
      riskLevel: 'medium',
      ruleIds: ['rule-1'],
      blockedRuleIds: ['rule-1'],
      violations: [{ type: 'bad_fact', evidence: 'x', suggestion: 'y' }],
    },
    repairMode: 'rewrite',
    repaired: true,
    revisedReply: '重写版',
    revised: {
      decision: 'pass',
      riskLevel: 'low',
      ruleIds: [],
      blockedRuleIds: [],
      violations: [],
    },
    finalDecision: 'pass',
  };

  it('delegates valid review writes to the repository', async () => {
    repository.insertReviewRecord.mockResolvedValueOnce('inserted');

    await expect(service.recordReview(validRecord)).resolves.toBe('inserted');

    expect(repository.insertReviewRecord).toHaveBeenCalledWith(validRecord);
  });

  it('rejects repaired writes that do not include revised review content', async () => {
    const invalid = {
      ...validRecord,
      revisedReply: undefined,
    } as unknown as GuardrailReviewInsertInput;

    await expect(service.recordReview(invalid)).resolves.toBe('failed');

    expect(repository.insertReviewRecord).not.toHaveBeenCalled();
  });

  it('delegates trace lookup to the repository', async () => {
    repository.findByTraceId.mockResolvedValueOnce({ traceId: 'msg-1' });

    await expect(service.findByTraceId('msg-1')).resolves.toEqual({ traceId: 'msg-1' });

    expect(repository.findByTraceId).toHaveBeenCalledWith('msg-1');
  });
});
