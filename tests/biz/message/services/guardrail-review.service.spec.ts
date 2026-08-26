import { GuardrailReviewRepository } from '@biz/message/repositories/guardrail-review.repository';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import type { GuardrailReviewInsertInput } from '@biz/message/types/guardrail-review.types';
import type { AlertNotifierService } from '@notification/services/alert-notifier.service';

describe('GuardrailReviewService', () => {
  const repository = {
    insertReviewRecord: jest.fn(),
    findByTraceId: jest.fn(),
  };
  const alertNotifier = {
    sendAlert: jest.fn().mockResolvedValue(true),
  };
  const service = new GuardrailReviewService(
    repository as unknown as GuardrailReviewRepository,
    alertNotifier as unknown as AlertNotifierService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    alertNotifier.sendAlert.mockResolvedValue(true);
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
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('rejects repaired writes that do not include revised review content', async () => {
    const invalid = {
      ...validRecord,
      revisedReply: undefined,
    } as unknown as GuardrailReviewInsertInput;

    await expect(service.recordReview(invalid)).resolves.toBe('failed');

    expect(repository.insertReviewRecord).not.toHaveBeenCalled();
    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'guardrail_review_persist_failed',
        diagnostics: expect.objectContaining({ category: 'invalid_review_input' }),
      }),
    );
  });

  it('alerts when the repository write fails', async () => {
    repository.insertReviewRecord.mockResolvedValueOnce('failed');

    await expect(service.recordReview(validRecord)).resolves.toBe('failed');

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'guardrail_review_persist_failed',
        scope: expect.objectContaining({ messageId: 'msg-1' }),
        diagnostics: expect.objectContaining({ category: 'db_write_failed' }),
      }),
    );
  });

  it('does not alert on duplicate writes and swallows alert failures', async () => {
    repository.insertReviewRecord.mockResolvedValueOnce('duplicate');
    await expect(service.recordReview(validRecord)).resolves.toBe('duplicate');
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();

    // 告警自身失败不反噬写入链路
    repository.insertReviewRecord.mockResolvedValueOnce('failed');
    alertNotifier.sendAlert.mockRejectedValueOnce(new Error('feishu down'));
    await expect(service.recordReview(validRecord)).resolves.toBe('failed');
  });

  it('delegates trace lookup to the repository', async () => {
    repository.findByTraceId.mockResolvedValueOnce({ traceId: 'msg-1' });

    await expect(service.findByTraceId('msg-1')).resolves.toEqual({ traceId: 'msg-1' });

    expect(repository.findByTraceId).toHaveBeenCalledWith('msg-1');
  });
});
