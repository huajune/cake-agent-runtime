import {
  hasTruncatedFindingText,
  SemanticReviewerService,
  type SemanticReviewVerdict,
} from '@agent/guardrail/output/llm/semantic-reviewer.service';
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
          jobList: { args: {}, hasEvidence: true, jobs: [{ jobId: 101 }], requestedBrands: [] },
        },
      });
      expect(service.shouldReview(packet)).toBe(true);
    });

    it('jobList 证据为空数组（召回 0 岗）→ 不触发 job 推荐档', () => {
      const packet = makePacket({
        draftReply: '推荐你去静安寺店',
        evidence: { jobList: { args: {}, hasEvidence: false, jobs: [], requestedBrands: [] } },
      });
      expect(service.shouldReview(packet)).toBe(false);
    });

    it('结构化 jobs 为空但有 markdownExcerpt（工具只回 markdown）→ 仍触发 job 推荐档', () => {
      const packet = makePacket({
        draftReply: '推荐你去静安寺店，薪资 24 元/小时',
        evidence: {
          jobList: {
            args: {},
            hasEvidence: true,
            jobs: [],
            requestedBrands: [],
            markdownExcerpt: '# 在招岗位（共 1 个）\n\n## 瑞幸咖啡（静安寺店）',
          },
        },
      });
      expect(service.shouldReview(packet)).toBe(true);
    });

    it('jobs 为空且无 markdownExcerpt → 跳过（与有 excerpt 的对照）', () => {
      const packet = makePacket({
        draftReply: '推荐你去静安寺店，薪资 24 元/小时',
        evidence: { jobList: { args: {}, hasEvidence: false, jobs: [], requestedBrands: [] } },
      });
      expect(service.shouldReview(packet)).toBe(false);
    });

    it('有 markdownExcerpt 但回复是纯寒暄 → 不触发（措辞条件仍然生效）', () => {
      const packet = makePacket({
        draftReply: '好的，祝你顺利',
        evidence: {
          jobList: {
            args: {},
            hasEvidence: true,
            jobs: [],
            requestedBrands: [],
            markdownExcerpt: '# 在招岗位（共 1 个）',
          },
        },
      });
      expect(service.shouldReview(packet)).toBe(false);
    });

    it('geocode 证据 + 位置结论措辞 → 触发', () => {
      const packet = makePacket({
        draftReply: '你附近有门店',
        evidence: { geocode: { candidates: ['上海市静安寺'], hasResolvedCoordinate: false } },
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
          jobList: { args: {}, hasEvidence: true, jobs: [{ jobId: 101 }], requestedBrands: [] },
          booking: { success: true },
          geocode: { candidates: ['上海'], hasResolvedCoordinate: false },
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

    it('drops job missing-evidence findings contradicted by markdown evidence', async () => {
      llm.generateStructured.mockResolvedValue({
        output: {
          decision: 'block',
          confidence: 'high',
          findings: [
            {
              code: 'job_recommendation_not_best_supported',
              evidencePath: 'evidence.jobList.jobs',
              evidenceQuote: '推荐必胜客岗位',
              userImpact: 'jobList.jobs 为空数组，无任何岗位数据支撑',
              repairMode: 'replan',
              feedbackToGenerator: '不要推荐任何岗位',
            },
          ],
        },
      });

      const result = await service.review(
        makePacket({
          evidence: {
            jobList: {
              args: {},
              hasEvidence: true,
              jobs: [],
              requestedBrands: [],
              markdownExcerpt: '# 在招岗位（共 1 个）\n必胜客（丹灶店）- 服务员',
            },
          },
        }),
      );

      expect(result).toMatchObject({
        decision: 'pass',
        confidence: 'low',
        findings: [],
      });
    });

    it('drops geocode-unavailable findings contradicted by resolved coordinates', async () => {
      llm.generateStructured.mockResolvedValue({
        output: {
          decision: 'revise',
          confidence: 'high',
          findings: [
            {
              code: 'brand_or_geo_ambiguity_ignored',
              evidencePath: 'evidence.geocode.candidates',
              evidenceQuote: '顺德附近',
              userImpact: 'geocode.candidates 为空，地理解析失败',
              repairMode: 'rewrite',
              feedbackToGenerator: '不要说附近',
            },
          ],
        },
      });

      const result = await service.review(
        makePacket({
          evidence: {
            geocode: {
              resolution: 'unique',
              formattedAddress: '广东省佛山市顺德区',
              latitude: 22.805413,
              longitude: 113.293197,
              areaLevelQuery: true,
              hasResolvedCoordinate: true,
              candidates: [],
            },
          },
        }),
      );

      expect(result).toMatchObject({
        decision: 'pass',
        confidence: 'low',
        findings: [],
      });
    });
  });

  describe('hasTruncatedFindingText（约束解码截断检测）', () => {
    const makeVerdict = (
      finding: Partial<SemanticReviewVerdict['findings'][number]>,
    ): SemanticReviewVerdict => ({
      decision: 'revise',
      confidence: 'high',
      findings: [
        {
          code: 'brand_or_geo_ambiguity_ignored',
          evidencePath: 'evidence.jobList',
          evidenceQuote: '成都你六姐（1788广场店）',
          userImpact: '候选人可能误认为需要前往成都工作',
          repairMode: 'rewrite',
          feedbackToGenerator: '请明确说明「成都你六姐」是品牌名，门店在上海',
          ...finding,
        },
      ],
    });

    it('识别生产截断样本：userImpact 断在悬垂及物成分', () => {
      expect(
        hasTruncatedFindingText(
          makeVerdict({ userImpact: '候选人位于上海市长宁区，但回复推荐的岗位品牌名为' }),
        ),
      ).toBe(true);
      expect(hasTruncatedFindingText(makeVerdict({ userImpact: '回复提到' }))).toBe(true);
      expect(hasTruncatedFindingText(makeVerdict({ feedbackToGenerator: '回复误将' }))).toBe(true);
    });

    it('完整句子不误判为截断', () => {
      expect(hasTruncatedFindingText(makeVerdict({}))).toBe(false);
      expect(
        hasTruncatedFindingText(makeVerdict({ userImpact: '候选人会误以为门店在成都而流失。' })),
      ).toBe(false);
      expect(
        hasTruncatedFindingText(makeVerdict({ feedbackToGenerator: '删除关于面试地址的声称' })),
      ).toBe(false);
    });

    it('review 输出被截断时 validateOutput 抛错触发重试策略', async () => {
      llm.generateStructured.mockImplementation(
        (options: { validateOutput?: (output: unknown) => void }) => {
          options.validateOutput?.(
            makeVerdict({ userImpact: '候选人位于上海市长宁区，但回复推荐的岗位品牌名为' }),
          );
          return Promise.resolve({ output: makeVerdict({}) });
        },
      );

      await expect(service.review(makePacket())).rejects.toThrow(/truncated/);
    });
  });
});
