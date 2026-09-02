// 知识归类：procedural —— 本段定义模型绝对禁止的行为。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（程序性红线规则总账）
import { buildTextPromptBlock, type PromptSection } from '../section.interface';
import type { PromptModel } from '../../prompt-model.types';
import { StrategyRedLines } from '@biz/strategy/types/strategy.types';

/**
 * 红线规则段落 — 绝对禁止的行为
 */
export class RedLinesSection implements PromptSection {
  readonly id = 'red-lines';
  readonly domain = 'teaching' as const;
  readonly slot = 'strategy' as const;
  readonly dynamic = true;

  build(model: PromptModel) {
    return buildTextPromptBlock(this, this.buildRedLinesText(model.strategy.redLines));
  }

  private buildRedLinesText(redLines: StrategyRedLines): string {
    if (!redLines?.rules || redLines.rules.length === 0) return '';
    const rulesText = redLines.rules.map((rule) => `- ${rule}`).join('\n');
    return `# 红线规则（以下行为绝对禁止）\n${rulesText}`;
  }
}
