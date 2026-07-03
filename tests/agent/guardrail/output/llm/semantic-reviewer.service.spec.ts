import { SemanticReviewerService } from '@agent/guardrail/output/llm/semantic-reviewer.service';
import type { GuardrailReviewPacket } from '@agent/guardrail/output/llm/review-packet.types';
import { ModelRole } from '@/llm/llm.types';
import type { LlmExecutorService } from '@/llm/llm-executor.service';

function makePacket(overrides: Partial<GuardrailReviewPacket> = {}): GuardrailReviewPacket {
  return {
    draftReply: '你好',
    latestUserMessages: [],
    evidence: {},
    policies: { redLines: [], outputRuleHits: [] },
    ...overrides,
  };
}

describe('SemanticReviewerService', () => {
  let llm: { generateStructured: jest.Mock };
  let service: SemanticReviewerService;

  beforeEach(() => {
    llm = { generateStructured: jest.fn() };
    service = new SemanticReviewerService(llm as unknown as LlmExecutorService);
  });

  describe('shouldReview', () => {
    it('jobList 证据 + 推荐措辞 → 触发', () => {
      const packet = makePacket({
        draftReply: '推荐你去静安寺店，薪资 24 元/小时',
        evidence: {
          jobList: { args: {}, jobs: [{ jobId: 101 }], requestedBrands: [] },
        },
      });
      expect(service.shouldReview(packet)).toBe(true);
    });

    it('jobList 证据为空数组（召回 0 岗）→ 不触发 job 推荐档', () => {
      const packet = makePacket({
        draftReply: '推荐你去静安寺店',
        evidence: { jobList: { args: {}, jobs: [], requestedBrands: [] } },
      });
      expect(service.shouldReview(packet)).toBe(false);
    });

    it('geocode 证据 + 位置结论措辞 → 触发', () => {
      const packet = makePacket({
        draftReply: '你附近有门店',
        evidence: { geocode: { candidates: ['上海市静安寺'] } },
      });
      expect(service.shouldReview(packet)).toBe(true);
    });

    it('booking 证据 + 预约状态措辞 → 触发', () => {
      const packet = makePacket({
        draftReply: '面试时间定在明天下午',
        evidence: { booking: { success: true } },
      });
      expect(service.shouldReview(packet)).toBe(true);
    });

    it('有证据但回复是纯寒暄 → 不触发', () => {
      const packet = makePacket({
        draftReply: '好的，祝你顺利',
        evidence: {
          jobList: { args: {}, jobs: [{ jobId: 101 }], requestedBrands: [] },
          booking: { success: true },
          geocode: { candidates: ['上海'] },
        },
      });
      expect(service.shouldReview(packet)).toBe(false);
    });

    it('有触发措辞但无任何证据 → 不触发（LLM 不能自证，无证据不审）', () => {
      const packet = makePacket({ draftReply: '推荐你去这家门店，已帮你预约面试' });
      expect(service.shouldReview(packet)).toBe(false);
    });
  });

  describe('review', () => {
    it('以 Review 角色调用结构化生成，packet 作为 user 消息传入，透传 verdict', async () => {
      const verdict = {
        decision: 'revise',
        confidence: 'high',
        findings: [
          {
            code: 'active_booking_state_conflict',
            evidencePath: 'evidence.booking.confirmedInterviewTimeHuman',
            evidenceQuote: '明天见',
            userImpact: '漏了确认的面试时间',
            repairMode: 'rewrite',
            feedbackToGenerator: '补上面试时间',
          },
        ],
      };
      llm.generateStructured.mockResolvedValue({ output: verdict });

      const packet = makePacket({ draftReply: '明天见' });
      const result = await service.review(packet);

      expect(result).toEqual(verdict);
      const callArgs = llm.generateStructured.mock.calls[0][0];
      expect(callArgs.role).toBe(ModelRole.Review);
      expect(callArgs.messages[1]).toEqual({ role: 'user', content: JSON.stringify(packet) });
    });

    it('llm 层抛错时不吞异常（由 OutputGuardrailService 做 fail-close/fail-open 降级）', async () => {
      llm.generateStructured.mockRejectedValue(new Error('provider down'));
      await expect(service.review(makePacket())).rejects.toThrow('provider down');
    });
  });
});
