import { PROMPT_EXAMPLE_REGISTRY } from '@agent/guardrail/prompt/example-registry';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 注册 canary value 出站扫描。
 *
 * 判定只做封闭注册值的字符串包含比对；observe 入场，仅落档积累精确率，不改写或阻断回复。
 */
export function detectExampleValueLeak(replyText: string): RuleContradiction | null {
  const matched = PROMPT_EXAMPLE_REGISTRY.filter((entry) => replyText.includes(entry.value));
  if (matched.length === 0) return null;

  return {
    ruleId: 'example_value_leak',
    label: `回复包含注册示例值：${matched.map((entry) => `${entry.kind}:${entry.value}`).join('、')}`,
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}
