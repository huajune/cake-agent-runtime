/**
 * Input / Tool / Output 规则的聚合审计视图，不重复维护 ID、默认策略或源码映射。
 * Runner 恢复流程、Repair 回归检查和 Sanitizer 清洗直接由实现与行为测试维护，不另行登记。
 * 工具门禁实现保留在 tools / resolution，避免反向依赖 agent。
 */
import type { GuardrailLayer } from '@shared-types/guardrail.contract';
import type { GuardrailCatalogEntry } from './catalog.types';
import { INPUT_GUARDRAIL_CATALOG } from './input/input-rule-catalog';
import { OUTPUT_RULE_CATALOG } from './output/output-rule-catalog';
import { TOOL_GUARDRAIL_CATALOG } from './tool/tool-guardrail.catalog';

export type { GuardrailCatalogEntry } from './catalog.types';

export const GUARDRAIL_CATALOG: readonly GuardrailCatalogEntry[] = [
  ...INPUT_GUARDRAIL_CATALOG,
  ...TOOL_GUARDRAIL_CATALOG.map(
    (guardrail): GuardrailCatalogEntry => ({ ...guardrail, layer: 'tool' }),
  ),
  ...OUTPUT_RULE_CATALOG.map(
    (rule): GuardrailCatalogEntry => ({
      id: rule.id,
      layer: 'output',
      stage: 'output_pre_send',
      action: rule.action,
      coverage: 'code',
      priority: rule.priority,
      description: rule.description,
      riskGoal: rule.riskGoal,
      source: rule.source,
      entrypoint: rule.entrypoint,
      exogenousSignal: rule.exogenousSignal,
      residualRisk: rule.residualRisk,
      verification: rule.verification,
      owner: 'agent-runtime',
      status: 'active',
    }),
  ),
];

export function catalogByLayer(layer: GuardrailLayer): GuardrailCatalogEntry[] {
  return GUARDRAIL_CATALOG.filter((entry) => entry.layer === layer);
}
