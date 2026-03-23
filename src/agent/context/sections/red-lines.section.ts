import { PromptSection, PromptContext } from './section.interface';
import { StrategyRedLines } from '@shared-types/strategy-config.types';

/**
 * 红线规则段落 — 绝对禁止的行为
 */
export class RedLinesSection implements PromptSection {
  readonly name = 'red-lines';

  build(ctx: PromptContext): string {
    return this.buildRedLinesText(ctx.strategyConfig.red_lines);
  }

  private buildRedLinesText(redLines: StrategyRedLines): string {
    if (!redLines?.rules || redLines.rules.length === 0) return '';
    const rulesText = redLines.rules.map((rule) => `- ${rule}`).join('\n');
    return `# 红线规则（以下行为绝对禁止）\n${rulesText}`;
  }
}
