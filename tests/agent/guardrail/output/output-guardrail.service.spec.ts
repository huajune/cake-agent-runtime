import { OutputGuardrailService } from '@agent/guardrail/output/output-guardrail.service';
import type { GuardrailRuleAction } from '@agent/guardrail/output/output-rule.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

describe('OutputGuardrailService', () => {
  const makeRuleResult = (
    contradictions: Array<{
      ruleId: string;
      label: string;
      action?: GuardrailRuleAction;
      currentReplySendable?: boolean;
      recoverability?: 'recoverable' | 'non_recoverable';
      repairMode?: 'rewrite' | 'replan';
      severity?: 'P0' | 'P1' | 'P2';
      feedbackToGenerator?: string;
    }> = [],
  ) => ({
    hit: contradictions.length > 0,
    contradictions,
  });

  const makeFinding = (over: Record<string, unknown> = {}) => ({
    code: 'active_booking_state_conflict',
    evidencePath: 'evidence.booking',
    evidenceQuote: '已帮你约好明天面试',
    userImpact: '候选人拿到与预约状态冲突的信息',
    repairMode: 'rewrite',
    feedbackToGenerator: '按 booking 证据重写预约状态表述',
    ...over,
  });

  const build = (
    llmEnabled: boolean,
    ruleResult: ReturnType<typeof makeRuleResult>,
    semanticReviewer: { shouldReview: jest.Mock; review: jest.Mock },
    options: { semanticShadowEnabled?: boolean; reviewModelConfigured?: boolean } = {},
  ) => {
    // 开关已迁到托管配置 agent_reply_config（Dashboard 即时生效）
    const systemConfig = {
      getAgentReplyConfig: jest.fn().mockResolvedValue({
        outputGuardrailLlmEnabled: llmEnabled,
        outputGuardrailSemanticShadowEnabled: options.semanticShadowEnabled ?? false,
      }),
    };
    const ruleGuard = { check: jest.fn().mockReturnValue(ruleResult) };
    const packetBuilder = {
      build: jest.fn().mockReturnValue({
        draftReply: '你好，有几个门店可以看看',
        latestUserMessages: [],
        evidence: { jobList: { jobs: [{ storeName: '静安店' }] } },
        policies: { redLines: [], outputRuleHits: [] },
      }),
    };
    const semanticNotifier = {
      notifyVerdict: jest.fn().mockResolvedValue(true),
      notifyReviewerFailure: jest.fn().mockResolvedValue(undefined),
    };
    const shortTerm = { getMessages: jest.fn().mockResolvedValue([]) };
    const router = {
      getModelIdByRole: jest
        .fn()
        .mockReturnValue(options.reviewModelConfigured === false ? '' : 'anthropic/claude-x'),
    };
    const service = new OutputGuardrailService(
      systemConfig as never,
      ruleGuard as never,
      packetBuilder as never,
      semanticReviewer as never,
      semanticNotifier as never,
      shortTerm as never,
      router as never,
    );
    return {
      service,
      ruleGuard,
      packetBuilder,
      semanticReviewer,
      semanticNotifier,
      shortTerm,
      router,
    };
  };

  const noTriggerReviewer = () => ({
    shouldReview: jest.fn().mockReturnValue(false),
    review: jest.fn(),
  });

  const baseInput = (over: Record<string, unknown> = {}) => ({
    reply: '你好，有几个门店可以看看',
    toolCalls: [],
    redLines: [],
    ...over,
  });

  it('flag 关闭：rule 非 block 命中 → pass，且不调用 llm', async () => {
    const reviewer = noTriggerReviewer();
    const { service } = build(
      false,
      makeRuleResult([{ ruleId: 'repeated_reply', label: 'x', action: GUARDRAIL_ACTION.OBSERVE }]),
      reviewer,
    );

    const decision = await service.check(baseInput());

    expect(decision.decision).toBe('pass');
    expect(decision.ruleIds).toEqual(['repeated_reply']);
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('rule veto（block，如歧视外露）→ hard block，不调用 llm', async () => {
    const reviewer = noTriggerReviewer();
    const { service } = build(
      true,
      makeRuleResult([
        {
          ruleId: 'discriminatory_screening_leak',
          label: 'leak',
          action: GUARDRAIL_ACTION.BLOCK,
          currentReplySendable: false,
          recoverability: 'non_recoverable',
          repairMode: 'rewrite',
          severity: 'P0',
          feedbackToGenerator: '不要复述户籍/籍贯/民族，改为中性承接。',
        },
      ]),
      reviewer,
    );

    const decision = await service.check(baseInput({ reply: '不要新疆户籍的' }));

    expect(decision.decision).toBe('block');
    expect(decision.blockedRuleIds).toEqual(['discriminatory_screening_leak']);
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('flag 开 + 非高风险且语义 contract 未触发 → 不调用 llm，pass', async () => {
    const reviewer = noTriggerReviewer();
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '你好呀，今天天气不错' }));

    expect(decision.decision).toBe('pass');
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('flag 开 + 高风险（含承诺词）→ 触发 llm；verdict revise → revise，finding 映射为 violation', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockResolvedValue({
        decision: 'revise',
        confidence: 'high',
        findings: [makeFinding()],
      }),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(decision.decision).toBe('revise');
    expect(decision.repairMode).toBe('rewrite');
    expect(decision.violations).toHaveLength(1);
    expect(decision.violations[0].type).toBe('active_booking_state_conflict');
    expect(decision.feedbackToGenerator).toContain('按 booking 证据重写预约状态表述');
  });

  it('flag 开但 AGENT_REVIEW_MODEL 未配置 → 语义档降级为未开启（不 fail-close），并发降级告警', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn(),
    };
    const { service, semanticNotifier } = build(true, makeRuleResult(), reviewer, {
      semanticShadowEnabled: true,
      reviewModelConfigured: false,
    });

    // 高风险承诺词——若语义档未降级，缺模型会走 fail-close block 吞掉回复
    const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

    expect(reviewer.review).not.toHaveBeenCalled();
    expect(decision.decision).toBe('pass');
    expect(semanticNotifier.notifyReviewerFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failMode: 'fail_open' }),
    );
  });

  it('flag 开 + 语义 contract 触发（无高风险词）→ 也触发 llm；verdict replan → replan', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockResolvedValue({
        decision: 'replan',
        confidence: 'high',
        findings: [
          makeFinding({
            code: 'job_recommendation_not_best_supported',
            repairMode: 'replan',
            feedbackToGenerator: '重新查岗后按更近门店推荐',
          }),
        ],
      }),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '给你推荐宝山的门店哈' }));

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(decision.decision).toBe('replan');
    expect(decision.repairMode).toBe('replan');
  });

  it('flag 开 + 高风险（紧跟副作用工具）→ 触发 llm；verdict block → block', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockResolvedValue({
        decision: 'block',
        confidence: 'high',
        findings: [makeFinding({ code: 'active_booking_state_conflict' })],
      }),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(
      baseInput({
        reply: '名额给你留着',
        toolCalls: [{ toolName: 'duliday_interview_booking', args: {}, result: { success: true } }],
      }),
    );

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(decision.decision).toBe('block');
  });

  it('LLM 不能自证：低置信 revise 强制降级为 observe，不拦截', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockResolvedValue({
        decision: 'revise',
        confidence: 'low',
        findings: [makeFinding()],
      }),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

    expect(decision.decision).toBe('observe');
    // 降级后的 finding 不作为 enforce 意见喂回 generator
    expect(decision.violations).toHaveLength(0);
  });

  it('§9 降级：reviewer 故障 + 本轮含副作用工具 → 高风险 block', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockRejectedValue(new Error('llm down')),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(
      baseInput({
        reply: '已帮你约好',
        toolCalls: [{ toolName: 'duliday_interview_booking', args: {}, result: { success: true } }],
      }),
    );

    expect(decision.decision).toBe('block');
    expect(decision.reasonCode).toBe('output_review_unavailable');
  });

  it('§9 降级：reviewer 故障 + 高风险事实文本 → block', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockRejectedValue(new Error('llm down')),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '节假日双倍工资哦' }));

    expect(decision.decision).toBe('block');
    expect(decision.reasonCode).toBe('output_review_unavailable');
  });

  it('§9 降级：reviewer 故障 + 仅语义 contract 触发（低风险体验类）→ fail-open，回退 rule 裁决', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockRejectedValue(new Error('llm down')),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '给你推荐几家门店看看' }));

    expect(decision.decision).toBe('pass');
    expect(decision.reasonCode).toBeUndefined();
  });

  it('副作用工具被尝试但未成功（request_handoff dispatched:false）+ 普通回复 → 不触发 llm，pass', async () => {
    // P1：no-op 副作用（如 HANDOFF_NO_BOOKING 返回 dispatched:false）不应单凭工具名被当成
    // 「已提交副作用」拉起高风险审查，否则 reviewer 故障时会把本该正常投递的回复误 block。
    const reviewer = noTriggerReviewer();
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(
      baseInput({
        reply: '好的，那我先帮你看看其他门店',
        toolCalls: [{ toolName: 'request_handoff', args: {}, result: { dispatched: false } }],
      }),
    );

    expect(decision.decision).toBe('pass');
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('副作用工具尝试失败但回复含承诺词 → 仍走 commitment 档触发 llm', async () => {
    // 失败 booking 但回复过度承诺：commitment_or_fact 仍兜住，安全意图不丢。
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockResolvedValue({ decision: 'block', confidence: 'high', findings: [] }),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(
      baseInput({
        reply: '已帮你约好明天面试',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { errorType: 'date_unavailable' },
          },
        ],
      }),
    );

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(decision.decision).toBe('block');
  });

  it('rule revise + llm pass → 仍按 rule 裁决 revise，rule 反馈保留', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockResolvedValue({ decision: 'pass', confidence: 'high', findings: [] }),
    };
    const { service } = build(
      true,
      makeRuleResult([
        {
          ruleId: 'salary_fabrication',
          label: '薪资编造',
          action: GUARDRAIL_ACTION.REVISE,
          currentReplySendable: false,
          recoverability: 'recoverable',
          repairMode: 'rewrite',
          severity: 'P1',
          feedbackToGenerator: '薪资只按 jobSalary 表述。',
        },
      ]),
      reviewer,
    );

    const decision = await service.check(baseInput({ reply: '节假日双倍工资哦' }));

    expect(decision.decision).toBe('revise');
    expect(decision.violations.map((v) => v.type)).toEqual(['salary_fabrication']);
    expect(decision.feedbackToGenerator).toContain('薪资只按 jobSalary 表述');
  });

  it('shadow：enforce 关 + shadow 开 → 异步调用 reviewer，但不改变出站裁决', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockResolvedValue({
        decision: 'replan',
        confidence: 'high',
        findings: [makeFinding({ code: 'job_recommendation_not_best_supported' })],
      }),
    };
    const { service, packetBuilder } = build(false, makeRuleResult(), reviewer, {
      semanticShadowEnabled: true,
    });

    const decision = await service.check(
      baseInput({
        reply: '已帮你约好明天面试',
        toolCalls: [{ toolName: 'duliday_interview_booking', args: {}, result: { success: true } }],
      }),
    );

    expect(decision.decision).toBe('pass');
    expect(packetBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: '已帮你约好明天面试',
        outputRuleHits: [],
      }),
    );
    expect(reviewer.shouldReview).toHaveBeenCalled();
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });

  it('shadow：enforce 开时不再重复跑 shadow（review 只被 enforce 路径调用一次）', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockResolvedValue({ decision: 'pass', confidence: 'high', findings: [] }),
    };
    const { service } = build(true, makeRuleResult(), reviewer, {
      semanticShadowEnabled: true,
    });

    const decision = await service.check(baseInput({ reply: '给你推荐几家门店看看' }));

    expect(decision.decision).toBe('pass');
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });

  it('shadow 命中判例 → 异步上报 notifyVerdict(mode=shadow)，pass 判例不上报', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockResolvedValue({
        decision: 'revise',
        confidence: 'high',
        findings: [makeFinding()],
      }),
    };
    const { service, semanticNotifier } = build(false, makeRuleResult(), reviewer, {
      semanticShadowEnabled: true,
    });

    await service.check(baseInput({ chatId: 'chat-1', userMessage: '明天能面试吗' }));
    await new Promise((resolve) => setImmediate(resolve)); // flush fire-and-forget shadow

    expect(semanticNotifier.notifyVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'shadow',
        decision: 'revise',
        chatId: 'chat-1',
        findings: [expect.objectContaining({ code: 'active_booking_state_conflict' })],
      }),
    );

    // pass 且无 finding：不上报
    semanticNotifier.notifyVerdict.mockClear();
    reviewer.review.mockResolvedValue({ decision: 'pass', confidence: 'high', findings: [] });
    await service.check(baseInput());
    await new Promise((resolve) => setImmediate(resolve));
    expect(semanticNotifier.notifyVerdict).not.toHaveBeenCalled();
  });

  it('enforce 命中 → 上报 notifyVerdict(mode=enforce)', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockResolvedValue({
        decision: 'revise',
        confidence: 'high',
        findings: [makeFinding()],
      }),
    };
    const { service, semanticNotifier } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

    expect(decision.decision).toBe('revise');
    expect(semanticNotifier.notifyVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'enforce', decision: 'revise' }),
    );
  });

  it('低置信 enforce 结论降级 observe → 上报 notifyVerdict(mode=confidence_downgraded)', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(true),
      review: jest.fn().mockResolvedValue({
        decision: 'block',
        confidence: 'low',
        findings: [makeFinding()],
      }),
    };
    const { service, semanticNotifier } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

    // 降级为 observe：不拦截（回复仍可发送），只留观测记录
    expect(decision.decision).toBe('observe');
    expect(semanticNotifier.notifyVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'confidence_downgraded', decision: 'block' }),
    );
  });

  it('高风险触发且 reviewer 故障 → fail-close block 并发 ops 告警', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockRejectedValue(new Error('llm timeout')),
    };
    const { service, semanticNotifier } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(
      baseInput({
        reply: '已帮你约好明天面试',
        toolCalls: [{ toolName: 'duliday_interview_booking', args: {}, result: { success: true } }],
        chatId: 'chat-9',
      }),
    );

    expect(decision.decision).toBe('block');
    expect(decision.reasonCode).toBe('output_review_unavailable');
    expect(semanticNotifier.notifyReviewerFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failMode: 'fail_close', chatId: 'chat-9' }),
    );
  });

  it('silent（advisory）：enforce 命中仍返回裁决，但不 fire 判例上报，且 silent 透传 rule 档', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockResolvedValue({
        decision: 'revise',
        confidence: 'high',
        findings: [makeFinding()],
      }),
    };
    const { service, ruleGuard, semanticNotifier } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '已帮你约好明天面试', silent: true }));

    // 裁决照常返回（advisory 展示用）
    expect(decision.decision).toBe('revise');
    // 但不 fire 语义判例上报，避免污染生产 badcase
    expect(semanticNotifier.notifyVerdict).not.toHaveBeenCalled();
    // silent 透传给 rule 档，rule 命中同样不告警
    expect(ruleGuard.check).toHaveBeenCalledWith(expect.objectContaining({ silent: true }));
  });

  it('silent（advisory）：reviewer 故障 + 高风险 → 仍 block，但不 fire 故障告警', async () => {
    const reviewer = {
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockRejectedValue(new Error('llm down')),
    };
    const { service, semanticNotifier } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(
      baseInput({
        reply: '已帮你约好明天面试',
        toolCalls: [{ toolName: 'duliday_interview_booking', args: {}, result: { success: true } }],
        silent: true,
      }),
    );

    expect(decision.decision).toBe('block');
    expect(semanticNotifier.notifyReviewerFailure).not.toHaveBeenCalled();
  });

  // riskLevel 是 runner §9 repair 上限用尽后 fail-open 闸门的档位信号：
  // P0（high）必须 block，不能被语义档 revise=medium 的口径吞掉（2026-07-06 review Critical）。
  describe('riskLevel 组合（fail-open 闸门信号）', () => {
    const llmReviseReviewer = (finding: Record<string, unknown> = makeFinding()) => ({
      shouldReview: jest.fn().mockReturnValue(false),
      review: jest.fn().mockResolvedValue({
        decision: 'revise',
        confidence: 'high',
        findings: [finding],
      }),
    });

    it('rule P0（action=revise）+ llm revise → riskLevel high，P0 信号不被语义档吞掉', async () => {
      const { service } = build(
        true,
        makeRuleResult([
          {
            ruleId: 'tool_failure_success_claim',
            label: '工具失败但声称成功',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
            recoverability: 'recoverable',
            repairMode: 'rewrite',
            severity: 'P0',
          },
        ]),
        llmReviseReviewer(),
      );

      const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

      expect(decision.decision).toBe('revise');
      expect(decision.riskLevel).toBe('high');
    });

    it('rule P1（action=revise）+ llm revise → riskLevel medium，fail-open 仍可用', async () => {
      const { service } = build(
        true,
        makeRuleResult([
          {
            ruleId: 'wait_notice_time_fabrication',
            label: '等通知岗位编造时间',
            action: GUARDRAIL_ACTION.REVISE,
            currentReplySendable: false,
            recoverability: 'recoverable',
            repairMode: 'rewrite',
            severity: 'P1',
          },
        ]),
        llmReviseReviewer(makeFinding({ code: 'job_recommendation_not_best_supported' })),
      );

      const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

      expect(decision.decision).toBe('revise');
      expect(decision.riskLevel).toBe('medium');
    });

    it('无 rule 命中 + llm revise 含 P0 finding（booking 状态冲突）→ riskLevel high', async () => {
      const { service } = build(true, makeRuleResult(), llmReviseReviewer());

      const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

      expect(decision.decision).toBe('revise');
      expect(decision.riskLevel).toBe('high');
      expect(decision.violations[0].severity).toBe('P0');
      // 语义 finding 的 recoverability 必须显式赋值——undefined 会让 runner 的
      // fail-open 闸门（!== 'non_recoverable'）恒为真
      expect(decision.violations[0].recoverability).toBe('recoverable');
    });

    it('无 rule 命中 + llm revise 仅 P2 finding（推荐非最优）→ riskLevel medium', async () => {
      const { service } = build(
        true,
        makeRuleResult(),
        llmReviseReviewer(makeFinding({ code: 'job_recommendation_not_best_supported' })),
      );

      const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

      expect(decision.decision).toBe('revise');
      expect(decision.riskLevel).toBe('medium');
      expect(decision.violations[0].severity).toBe('P2');
    });
  });
});
