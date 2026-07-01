import { OutputGuardrailService } from '@agent/guardrail/output/output-guardrail.service';

describe('OutputGuardrailService', () => {
  const makeRuleResult = (
    contradictions: Array<{
      ruleId: string;
      label: string;
      action: 'observe' | 'revise' | 'block';
    }> = [],
  ) => ({
    hit: contradictions.length > 0,
    contradictions,
  });

  const build = (
    llmEnabled: boolean,
    ruleResult: ReturnType<typeof makeRuleResult>,
    reviewer: { review: jest.Mock },
  ) => {
    const configService = {
      get: jest.fn().mockReturnValue(llmEnabled ? 'true' : 'false'),
    };
    const ruleGuard = { check: jest.fn().mockReturnValue(ruleResult) };
    const service = new OutputGuardrailService(
      configService as never,
      ruleGuard as never,
      reviewer as never,
    );
    return { service, ruleGuard, reviewer };
  };

  const baseInput = (over: Record<string, unknown> = {}) => ({
    reply: '你好，有几个门店可以看看',
    toolCalls: [],
    redLines: [],
    ...over,
  });

  it('flag 关闭：rule 非 block 命中 → pass，且不调用 llm', async () => {
    const reviewer = { review: jest.fn() };
    const { service } = build(
      false,
      makeRuleResult([{ ruleId: 'group_promise_without_invite', label: 'x', action: 'observe' }]),
      reviewer,
    );

    const decision = await service.check(baseInput());

    expect(decision.decision).toBe('pass');
    expect(decision.ruleIds).toEqual(['group_promise_without_invite']);
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('flag 关闭：rule action=revise → revise，且不调用 llm', async () => {
    const reviewer = { review: jest.fn() };
    const { service } = build(
      false,
      makeRuleResult([
        { ruleId: 'booking_form_field_mismatch', label: 'missing field', action: 'revise' },
      ]),
      reviewer,
    );

    const decision = await service.check(baseInput());

    expect(decision.decision).toBe('revise');
    expect(decision.ruleIds).toEqual(['booking_form_field_mismatch']);
    expect(decision.violations).toEqual([
      expect.objectContaining({ type: 'booking_form_field_mismatch' }),
    ]);
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('rule 硬 block（歧视外露）→ block，且不调用 llm', async () => {
    const reviewer = { review: jest.fn() };
    const { service } = build(
      true,
      makeRuleResult([{ ruleId: 'discriminatory_screening_leak', label: 'leak', action: 'block' }]),
      reviewer,
    );

    const decision = await service.check(baseInput({ reply: '不要新疆户籍的' }));

    expect(decision.decision).toBe('block');
    expect(decision.blockedRuleIds).toEqual(['discriminatory_screening_leak']);
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('flag 开 + 非高风险回复 → 不触发 llm，pass', async () => {
    const reviewer = { review: jest.fn() };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '你好呀，今天天气不错' }));

    expect(decision.decision).toBe('pass');
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('flag 开 + 高风险（含承诺词）→ 触发 llm；llm revise → revise', async () => {
    const reviewer = {
      review: jest.fn().mockResolvedValue({
        decision: 'revise',
        riskLevel: 'medium',
        violations: [{ type: 'bad_tone', evidence: 'x', suggestion: 'y' }],
      }),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '已帮你约好明天面试' }));

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(decision.decision).toBe('revise');
    expect(decision.violations).toHaveLength(1);
  });

  it('flag 开 + 高风险（紧跟副作用工具）→ 触发 llm；llm block → block', async () => {
    const reviewer = {
      review: jest.fn().mockResolvedValue({
        decision: 'block',
        riskLevel: 'high',
        violations: [{ type: 'unsupported_commitment', evidence: 'x', suggestion: 'y' }],
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

  it('§9 降级：reviewer 故障 + 本轮含副作用工具 → 高风险 block', async () => {
    const reviewer = { review: jest.fn().mockRejectedValue(new Error('llm down')) };
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
    const reviewer = { review: jest.fn().mockRejectedValue(new Error('llm down')) };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(baseInput({ reply: '节假日双倍工资哦' }));

    expect(decision.decision).toBe('block');
    expect(decision.reasonCode).toBe('output_review_unavailable');
  });

  it('副作用工具被尝试但未成功（request_handoff dispatched:false）+ 普通回复 → 不触发 llm，pass', async () => {
    // P1：no-op 副作用（如 HANDOFF_NO_BOOKING 返回 dispatched:false）不应单凭工具名被当成
    // 「已提交副作用」拉起高风险审查，否则 reviewer 故障时会把本该正常投递的回复误 block。
    const reviewer = { review: jest.fn() };
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

  it('副作用工具被尝试但未成功 + reviewer 故障 → 不再误判高风险 block', async () => {
    const reviewer = { review: jest.fn().mockRejectedValue(new Error('llm down')) };
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
      review: jest.fn().mockResolvedValue({ decision: 'block', riskLevel: 'high', violations: [] }),
    };
    const { service } = build(true, makeRuleResult(), reviewer);

    const decision = await service.check(
      baseInput({
        reply: '已帮你约好明天面试',
        toolCalls: [
          { toolName: 'duliday_interview_booking', args: {}, result: { errorType: 'date_unavailable' } },
        ],
      }),
    );

    expect(reviewer.review).toHaveBeenCalledTimes(1);
    expect(decision.decision).toBe('block');
  });
});
