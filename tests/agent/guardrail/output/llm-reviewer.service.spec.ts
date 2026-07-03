import { LlmReviewerService } from '@agent/guardrail/output/llm-reviewer.service';
import { ModelRole } from '@/llm/llm.types';

describe('LlmReviewerService', () => {
  const buildLlm = (output: unknown) => ({
    generateStructured: jest.fn().mockResolvedValue({ output }),
  });

  it('maps structured output to verdict and calls Review role', async () => {
    const llm = buildLlm({
      decision: 'revise',
      riskLevel: 'medium',
      violations: [
        { type: 'hallucinated_fact', evidence: '说日结但工具是月结', suggestion: '改成月结' },
      ],
    });
    const service = new LlmReviewerService(llm as never);

    const verdict = await service.review({
      reply: '这个岗位日结哦',
      toolCalls: [
        { toolName: 'duliday_job_list', args: {}, result: { settlement: '月结' }, status: 'ok' },
      ],
      redLines: ['不得编造薪资'],
    });

    expect(verdict.decision).toBe('revise');
    expect(verdict.violations[0].type).toBe('hallucinated_fact');

    const callArgs = llm.generateStructured.mock.calls[0][0];
    expect(callArgs.role).toBe(ModelRole.Review);
    // grounding 进入 prompt：回复原文 + 工具结果 + 红线
    expect(callArgs.prompt).toContain('这个岗位日结哦');
    expect(callArgs.prompt).toContain('月结');
    expect(callArgs.prompt).toContain('不得编造薪资');
  });

  it('passes through an empty-violation pass verdict', async () => {
    const llm = buildLlm({ decision: 'pass', riskLevel: 'low', violations: [] });
    const service = new LlmReviewerService(llm as never);

    const verdict = await service.review({ reply: '你好', toolCalls: [], redLines: [] });

    expect(verdict.decision).toBe('pass');
    expect(verdict.violations).toEqual([]);
  });
});
