import { SemanticReviewRecorderService } from '@agent/guardrail/output/semantic-review-recorder.service';
import type { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';

describe('SemanticReviewRecorderService', () => {
  const guardrailReviews = {
    recordSemanticReview: jest.fn().mockResolvedValue(true),
  };
  const service = new SemanticReviewRecorderService(
    guardrailReviews as unknown as GuardrailReviewService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    guardrailReviews.recordSemanticReview.mockResolvedValue(true);
  });

  it('writes production semantic verdicts to guardrail_review_records', async () => {
    await expect(
      service.record({
        traceId: 'trace-1',
        chatId: 'chat-1',
        mode: 'shadow',
        decision: 'revise',
        confidence: 'high',
        findings: [
          {
            code: 'active_booking_state_conflict',
            evidenceQuote: '已帮你约好',
            userImpact: '预约状态冲突',
            feedbackToGenerator: '按预约工具证据重写',
          },
        ],
        draftReply: '已帮你约好明天面试',
      }),
    ).resolves.toBe(true);

    expect(guardrailReviews.recordSemanticReview).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'trace-1', mode: 'shadow', decision: 'revise' }),
    );
  });

  it('keeps debug/test traffic out of production guardrail logs when traceId is absent', async () => {
    await expect(
      service.record({
        mode: 'shadow',
        decision: 'pass',
        confidence: 'high',
        findings: [],
        draftReply: '你好',
      }),
    ).resolves.toBe(false);

    expect(guardrailReviews.recordSemanticReview).not.toHaveBeenCalled();
  });
});
