import { PromptSection, PromptContext } from './section.interface';
import { RiskScenario } from '@shared-types/strategy-config.types';

/**
 * 风险场景段落 — 从策略配置读取风险场景定义
 *
 * 告诉模型有哪些风险场景、对应的识别信号和应对策略。
 * 与 signal-detector 的 [风险提醒] 配合：
 * - 本 section：定义"有哪些风险、怎么应对"（静态，配置驱动）
 * - signal-detector：提醒"这轮触发了哪些风险"（动态，消息驱动）
 */
export class RiskScenariosSection implements PromptSection {
  readonly name = 'risk-scenarios';

  build(ctx: PromptContext): string {
    return this.buildRiskScenariosText(ctx.strategyConfig.red_lines.riskScenarios);
  }

  private buildRiskScenariosText(scenarios?: RiskScenario[]): string {
    if (!scenarios || scenarios.length === 0) return '';

    const lines = ['# 风险场景应对', '', '当 [风险提醒] 出现以下标记时，必须按对应策略处理：'];
    for (const s of scenarios) {
      lines.push(`- **${s.flag}**（${s.label}）：${s.signals} → ${s.strategy}`);
    }
    return lines.join('\n');
  }
}
