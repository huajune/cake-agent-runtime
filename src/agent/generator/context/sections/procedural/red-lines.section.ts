// 知识归类：procedural —— 本段定义模型绝对禁止的行为。
// prompt-rule-ledger: docs/prompt-rule-ledger.md（程序性红线规则总账）
// business-rules: SW-02
import { buildTextPromptBlock, type PromptSection } from '../section';
import type { PromptModel } from '../../context.types';
import { StrategyRedLines } from '@biz/strategy/types/strategy.types';

// 2026-11-04 SW-02 已统一按岗位字段回答，旧策略 R6 的“兼职必定不缴社保”废止。
// 仅兼容三份历史迁移中的精确文本，不按关键词过滤运营新规则，不修改策略存储。
// 来源：20260430238000 / 20260617073920 / 20260924160000；现行教学仅居于 sw.md。
const RETIRED_INSURANCE_RULES = new Set([
  '已约面阶段问社保/五险一金/公积金，直答"兼职岗位不缴纳社保"；严禁说"以门店为准 / 入职后再确认"。',
  '已约面阶段问社保/五险一金/公积金：兼职岗直答"兼职岗位不缴纳社保"；全职岗按岗位福利字段如实回答，无字段时只说"我帮你确认下"；严禁笼统说"以门店为准 / 入职后再确认"。',
  '已约面阶段问社保、五险一金或公积金时，兼职岗明确说明不缴纳社保；全职岗按岗位福利字段如实回答，无字段时先说明需要确认；严禁将未确认的责任推给门店或推迟到入职后。',
]);

/**
 * 红线规则段落 — 绝对禁止的行为
 */
export class RedLinesSection implements PromptSection {
  readonly id = 'red-lines';
  readonly domain = 'teaching' as const;
  readonly slot = 'strategy' as const;
  readonly dynamic = false;

  build(model: PromptModel) {
    return buildTextPromptBlock(this, this.buildRedLinesText(model.strategy.redLines));
  }

  private buildRedLinesText(redLines: StrategyRedLines): string {
    if (!redLines?.rules || redLines.rules.length === 0) return '';
    const activeRules = redLines.rules.filter((rule) => !RETIRED_INSURANCE_RULES.has(rule.trim()));
    if (activeRules.length === 0) return '';
    const rulesText = activeRules.map((rule) => `- ${rule}`).join('\n');
    return `# 红线规则（以下行为绝对禁止）\n${rulesText}`;
  }
}
