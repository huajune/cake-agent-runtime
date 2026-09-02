import { createHash } from 'node:crypto';
import { ContextService } from '@agent/generator/context/context.service';
import { renderPromptBlocks } from '@agent/generator/context/sections/section.interface';
import { PromptInjectionDetector } from '@agent/guardrail/input/prompt-injection-detector';
import { promptModelOf } from '../../helpers/prompt-model.fixture';

describe('Prompt compiler compatibility contract', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('locks block ids, domains, terminal slots, and final prompt bytes for a representative turn', async () => {
    const service = new ContextService();
    await service.onModuleInit();
    const stage = {
      stage: 'job_consultation',
      label: '岗位咨询',
      description: '按真实数据回答岗位问题',
      primaryGoal: '帮助候选人形成明确意向',
      successCriteria: ['问题已回答'],
      ctaStrategy: ['给出下一步'],
      disallowedActions: ['编造岗位'],
    };
    const model = promptModelOf({
      currentTimeText: '2026-09-02 08:00 星期三',
      identity: { botUserId: 'bot-1', nickname: '小蛋糕', gender: '女' },
      strategy: {
        roleSetting: { content: '你是招聘顾问。' },
        persona: { textDimensions: [] },
        redLines: { rules: ['禁止编造岗位信息'], thresholds: [] },
        thresholds: [],
        stages: [stage],
        currentStage: stage,
      } as never,
      memory: {
        ...promptModelOf().memory!,
        adjudication: {
          ...promptModelOf().memory!.adjudication,
          profile: {
            name: {
              value: '张三',
              confidence: 'high',
              source: 'user',
              evidence: '候选人自述',
              updatedAt: '2026-09-02T00:00:00.000Z',
            },
          },
        },
      } as never,
      groupInventory: {
        city: '上海',
        industries: [{ industry: '餐饮', groupCount: 2, availableCount: 1 }],
      },
      security: {
        injectionWarning: {
          category: 'prompt_leak',
          ruleId: 'prompt_leak_1',
          instruction: PromptInjectionDetector.GUARD_INSTRUCTION,
        },
      },
      criticalTurnInstructions: ['本轮必须先核验面试日期。'],
    });

    const result = service.compose(model);

    expect(result.promptBlocks.map((block) => block.id)).toEqual([
      'identity',
      'base-manual',
      'stage-overview',
      'red-lines',
      'candidate-memory',
      'booking-context',
      'datetime',
      'group-inventory',
      'stage-strategy',
      'final-check',
      'input-guard',
      'critical-turn-guard',
    ]);
    expect(result.promptBlocks.map((block) => block.domain)).toEqual([
      'teaching',
      'teaching',
      'teaching',
      'teaching',
      'evidence',
      'evidence',
      'tool_result',
      'tool_result',
      'teaching',
      'teaching',
      'teaching',
      'teaching',
    ]);
    expect(result.promptBlocks.at(-3)?.id).toBe('final-check');
    expect(result.promptBlocks.at(-2)?.id).toBe('input-guard');
    expect(result.promptBlocks.at(-1)?.id).toBe('critical-turn-guard');
    expect(renderPromptBlocks(result.promptBlocks)).toBe(result.systemPrompt);
    expect(createHash('sha256').update(result.systemPrompt).digest('hex')).toBe(
      '53b48c26824818b0302a788da50b4c00184b84422bb4ae81fcad8ffcfe13ff54',
    );
    expect(result.orderHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.dynamicBlockIds).toEqual(
      expect.arrayContaining([
        'identity',
        'candidate-memory',
        'input-guard',
        'critical-turn-guard',
      ]),
    );
  });
});
