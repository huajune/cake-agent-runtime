import type { AgentToolCall } from '@agent/generator/generator.types';
import type { OutputGuardDecision } from '../output-guardrail.service';
import { brandNameTransform } from './brand-name.transform';
import { districtLevelDistanceTransform } from './district-level-distance.transform';
import type { OutputRuleTransform } from './output-transform.types';

const TRANSFORMS: OutputRuleTransform[] = [brandNameTransform, districtLevelDistanceTransform];
const TRANSFORM_BY_RULE_ID = new Map(TRANSFORMS.map((transform) => [transform.ruleId, transform]));

export function applyOutputTransforms(
  text: string,
  decision: OutputGuardDecision,
  toolCalls: AgentToolCall[],
): string | null {
  const nonSendableRuleIds = [...new Set(decision.blockedRuleIds)];
  if (nonSendableRuleIds.length === 0) return null;
  if (!nonSendableRuleIds.every((ruleId) => TRANSFORM_BY_RULE_ID.has(ruleId))) return null;

  let transformed = text;
  for (const ruleId of nonSendableRuleIds) {
    const next = TRANSFORM_BY_RULE_ID.get(ruleId)?.apply(transformed, toolCalls);
    if (next === null || next === undefined) return null;
    transformed = next;
  }

  return transformed === text ? null : transformed;
}
