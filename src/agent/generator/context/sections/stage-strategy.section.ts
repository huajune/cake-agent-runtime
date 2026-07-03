import { PromptSection, PromptContext } from './section.interface';
import { StageGoalConfig } from '@shared-types/strategy-config.types';

/**
 * 阶段策略段落 — 当前阶段配置 + 所有阶段概览 + 推进提示
 *
 * 从 strategyConfig.stage_goals 中提取当前阶段的完整策略，
 * 并生成所有阶段的概览（含 description），供模型判断何时推进。
 */
export class StageStrategySection implements PromptSection {
  readonly name = 'stage-strategy';

  build(ctx: PromptContext): string {
    const stageGoals = this.buildStageGoalsMap(ctx);
    const currentStageKey = ctx.currentStage ?? Object.keys(stageGoals)[0] ?? 'trust_building';
    const stageConfig = stageGoals[currentStageKey] ?? Object.values(stageGoals)[0];

    if (!stageConfig) return '';

    const lines = this.buildCurrentStage(stageConfig);
    this.appendStageOverview(lines, stageGoals, stageConfig.stage);
    this.appendAdvanceHint(lines);

    return lines.join('\n');
  }

  private buildCurrentStage(config: StageGoalConfig): string[] {
    const lines = [
      '[当前阶段策略]',
      `阶段: ${config.stage} — ${config.label}`,
      `定义: ${config.description}`,
      `目标: ${config.primaryGoal}`,
    ];

    if (config.successCriteria?.length) {
      lines.push('成功标准:');
      for (const c of config.successCriteria) {
        lines.push(`- ${c}`);
      }
    }

    if (config.ctaStrategy?.length) {
      lines.push('CTA策略:');
      const strategies = Array.isArray(config.ctaStrategy)
        ? config.ctaStrategy
        : [config.ctaStrategy];
      for (const s of strategies) {
        lines.push(`- ${s}`);
      }
    }

    if (config.disallowedActions?.length) {
      lines.push('禁止行为:');
      for (const a of config.disallowedActions) {
        lines.push(`- ${a}`);
      }
    }

    return lines;
  }

  private appendStageOverview(
    lines: string[],
    stageGoals: Record<string, StageGoalConfig>,
    currentStage: string,
  ): void {
    const stages = Object.values(stageGoals);
    if (stages.length <= 1) return;

    lines.push('', '[所有阶段概览]');
    for (const stage of stages) {
      const marker = stage.stage === currentStage ? '→' : ' ';
      lines.push(`${marker} ${stage.stage}: ${stage.label}`);
      lines.push(`  ${stage.description}`);
    }
  }

  private appendAdvanceHint(lines: string[]): void {
    lines.push(
      '',
      '[阶段推进提示]',
      '当你判断当前阶段目标已达成，请调用 advance_stage 工具切换到下一阶段。',
    );
  }

  private buildStageGoalsMap(ctx: PromptContext): Record<string, StageGoalConfig> {
    const result: Record<string, StageGoalConfig> = {};
    for (const stage of ctx.strategyConfig.stage_goals.stages) {
      result[stage.stage] = stage;
    }
    return result;
  }
}
