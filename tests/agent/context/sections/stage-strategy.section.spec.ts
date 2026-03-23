import { StageStrategySection } from '@agent/context/sections/stage-strategy.section';
import { PromptContext } from '@agent/context/sections/section.interface';
import { StrategyConfigRecord, StageGoalConfig } from '@shared-types/strategy-config.types';

describe('StageStrategySection', () => {
  const section = new StageStrategySection();

  const makeStage = (overrides?: Partial<StageGoalConfig>): StageGoalConfig => ({
    stage: 'trust_building',
    label: '建立信任',
    description: '初次接触，建立信任',
    primaryGoal: '建立信任关系',
    successCriteria: ['候选人愿意沟通'],
    ctaStrategy: ['用轻量提问引导'],
    disallowedActions: ['跳过自我介绍'],
    ...overrides,
  });

  const makeCtx = (currentStage?: string): PromptContext => ({
    scenario: 'candidate-consultation',
    channelType: 'private',
    currentStage,
    strategyConfig: {
      stage_goals: {
        stages: [
          makeStage(),
          makeStage({
            stage: 'job_consultation',
            label: '岗位咨询',
            description: '根据候选人意向匹配岗位',
            primaryGoal: '回答岗位问题',
          }),
        ],
      },
    } as StrategyConfigRecord,
  });

  it('should format current stage strategy with all fields', () => {
    const block = section.build(makeCtx('trust_building'));

    expect(block).toContain('[当前阶段策略]');
    expect(block).toContain('trust_building — 建立信任');
    expect(block).toContain('建立信任关系');
    expect(block).toContain('候选人愿意沟通');
    expect(block).toContain('用轻量提问引导');
    expect(block).toContain('跳过自我介绍');
  });

  it('should include all stages overview with description', () => {
    const block = section.build(makeCtx('trust_building'));

    expect(block).toContain('[所有阶段概览]');
    expect(block).toContain('→ trust_building');
    expect(block).toContain('初次接触，建立信任');
    expect(block).toContain('  job_consultation');
    expect(block).toContain('根据候选人意向匹配岗位');
  });

  it('should include advance stage hint', () => {
    const block = section.build(makeCtx());

    expect(block).toContain('advance_stage');
  });

  it('should default to first stage when currentStage is undefined', () => {
    const block = section.build(makeCtx());

    expect(block).toContain('→ trust_building');
  });

  it('should mark correct current stage', () => {
    const block = section.build(makeCtx('job_consultation'));

    expect(block).toContain('→ job_consultation');
    expect(block).toContain('  trust_building');
  });

  it('should handle string ctaStrategy', () => {
    const ctx = makeCtx();
    (ctx.strategyConfig.stage_goals.stages[0] as StageGoalConfig).ctaStrategy =
      '单条策略' as unknown as string[];

    const block = section.build(ctx);

    expect(block).toContain('单条策略');
  });
});
