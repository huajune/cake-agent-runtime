import type {
  GuardrailAction,
  GuardrailCoverage,
  GuardrailLayer,
  GuardrailPriority,
  GuardrailStage,
} from '@shared-types/guardrail.contract';

/** Input / Tool / Output 规则共用的审计字段。 */
export interface GuardrailCatalogEntry {
  id: string;
  layer: GuardrailLayer;
  stage: GuardrailStage;
  action: GuardrailAction;
  coverage: GuardrailCoverage;
  priority: GuardrailPriority;
  description: string;
  riskGoal: string;
  /** 实现文件位置；具体函数或分支由 entrypoint 标明。 */
  source: string;
  entrypoint?: string;
  exogenousSignal: string;
  residualRisk: string;
  verification: string;
  owner: string;
  status: 'active' | 'planned';
}
