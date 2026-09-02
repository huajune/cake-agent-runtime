// 知识归类：procedural —— 本段定义各对话阶段的推进策略。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（程序性阶段策略总账）
import { buildTextPromptBlock, type PromptSection } from '../section';
import type { PromptModel } from '../../context.types';
import { StageGoalConfig } from '@biz/strategy/types/strategy.types';

/**
 * 当前阶段策略段落 — 只渲染随当前阶段变化的策略，固定置于 system 动态尾部。
 */
export class StageStrategySection implements PromptSection {
  readonly id = 'stage-strategy';
  readonly domain = 'teaching' as const;
  readonly slot = 'working-context' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    const stageConfig = model.strategy.currentStage;
    if (!stageConfig) return [];
    return buildTextPromptBlock(this, this.buildCurrentStage(stageConfig).join('\n'));
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
}

/** 全阶段静态地图；不读取 currentStage，保证跨轮渲染逐字节稳定。 */
export class StageOverviewSection implements PromptSection {
  readonly id = 'stage-overview';
  readonly domain = 'teaching' as const;
  readonly slot = 'stable-instructions' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    const stages = model.strategy.stages;
    const lines: string[] = [];

    if (stages.length > 1) {
      lines.push('[所有阶段概览]');
      for (const stage of stages) {
        lines.push(`  ${stage.stage}: ${stage.label}`);
        lines.push(`  ${stage.description}`);
      }
    }

    lines.push(
      ...(lines.length > 0 ? [''] : []),
      '[阶段推进提示]',
      '当你判断需要切换阶段时，下一步必须先单独调用 advance_stage：调用前不输出候选人文本，也不并行调用其他工具；收到 effectiveStageStrategy 后再继续业务工具和完整回复。',
    );

    return buildTextPromptBlock(this, lines.join('\n'));
  }
}
