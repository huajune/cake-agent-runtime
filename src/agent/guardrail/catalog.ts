/**
 * Guardrail 统一目录（可审计登记表）。
 *
 * 治理价值（§2.5）：逐条审计"每个 guardrail 带不带**新外生信号**"——只读同样信息再想
 * 一遍的 reviewer 在决策论上被中心化决策者支配，堆多了准确率反而崩。这里把现有/规划中的
 * guardrail 登记成一张表，`exogenousSignal` 字段是审计抓手；`source` 标注物理位置
 * （tool guardrail 因分层物理留 tools/，仅在此登记引用，不反向依赖 agent）。
 *
 * 注意：本目录是**聚合后的登记/审计视图**，不在此执行 guardrail（执行仍在各自的
 * in-loop / 出站调用点）。output/tool 的详细目录分别由各自子域维护，本文件只派生汇总，
 * 避免同一个 rule id 在多处手写后漂移。
 */

import type {
  GuardrailAction,
  GuardrailCoverage,
  GuardrailLayer,
  GuardrailPriority,
  GuardrailStage,
} from '@shared-types/guardrail.contract';
import { OUTPUT_RULE_CATALOG, OUTPUT_RULE_IDS } from './output/rules/output-rule-catalog';
import { TOOL_GUARDRAIL_CATALOG, TOOL_GUARDRAIL_IDS } from './tool/tool-guardrail.catalog';

const OUTPUT_RULE_SOURCE_BY_ID: Record<string, string> = {
  invalid_model_output:
    'agent/guardrail/output/rules/invalid-model-output.rule.ts（HardRulesService 调度）',
  brand_alias_fuzzy_match_ignored:
    'agent/guardrail/output/rules/brand-name-errors.rule.ts（HardRulesService 调度）',
  identity_misregistration_coaching:
    'agent/guardrail/output/rules/identity-fraud-coaching.rule.ts（HardRulesService 调度）',
  experience_fraud_coaching:
    'agent/guardrail/output/rules/experience-fraud-coaching.rule.ts（HardRulesService 调度）',
  discriminatory_screening_leak:
    'agent/guardrail/output/rules/discrimination-leaks.rule.ts（HardRulesService 调度）',
  sensitive_origin_probe:
    'agent/guardrail/output/rules/discrimination-leaks.rule.ts（HardRulesService 调度）',
  internal_output_leak:
    'agent/guardrail/output/rules/internal-info-leaks.rule.ts（HardRulesService 调度）',
  meta_narration_reply:
    'agent/guardrail/output/rules/internal-info-leaks.rule.ts（HardRulesService 调度）',
  quota_promise: 'agent/guardrail/output/rules/false-promises.rule.ts（HardRulesService 调度）',
  online_interview_location_claim:
    'agent/guardrail/output/rules/online-interview-location.rule.ts（HardRulesService 调度）',
  unsupported_store_status_speculation:
    'agent/guardrail/output/rules/store-status-speculation.rule.ts（HardRulesService 调度）',
  booking_receipt_mismatch:
    'agent/guardrail/output/rules/booking-receipt.rule.ts（HardRulesService 调度）',
  interview_time_change_unconfirmed:
    'agent/guardrail/output/rules/booking-receipt.rule.ts（HardRulesService 调度）',
  // ---- 数据复核恢复（1 条 revise + 5 条 observe 哨兵）----
  human_service_phrase_leak:
    'agent/guardrail/output/rules/internal-info-leaks.rule.ts（HardRulesService 调度）',
  booking_done_claim_without_submission:
    'agent/guardrail/output/rules/booking-claim-reconciliation.rule.ts（HardRulesService 调度）',
  dangling_reply_promise:
    'agent/guardrail/output/rules/dangling-promise.rule.ts（HardRulesService 调度）',
  requested_brand_mismatch:
    'agent/guardrail/output/rules/brand-name-errors.rule.ts（HardRulesService 调度）',
  settlement_cycle_mismatch:
    'agent/guardrail/output/rules/settlement-cycle-mismatch.rule.ts（HardRulesService 调度）',
  proactive_insurance_policy_mention:
    'agent/guardrail/output/rules/insurance-policy-claims.rule.ts（HardRulesService 调度）',
};

export interface GuardrailCatalogEntry {
  /** 稳定 id（rule id / service 名）。 */
  id: string;
  layer: GuardrailLayer;
  /** 生效点：用于审计是否存在绕过路径。 */
  stage: GuardrailStage;
  /** 执行动作：用于区分 prompt-only / observe / revise / block 等强度。 */
  action: GuardrailAction;
  /** 覆盖来源：避免 prompt-only 被误计入代码强覆盖。 */
  coverage: GuardrailCoverage;
  /** 缺口治理优先级。 */
  priority: GuardrailPriority;
  /** 面向风险目标，而不是实现细节。 */
  riskGoal: string;
  /** 物理位置（文件/服务）。 */
  source: string;
  /** 该 guardrail 对齐/带入的"新外生信号"——审计核心字段。 */
  exogenousSignal: string;
  /** 当前仍然存在的绕过/误杀/未覆盖风险。 */
  residualRisk: string;
  /** 至少一个可复核证据：测试、文档、或人工验收说明。 */
  verification: string;
  /** 团队/模块 owner，避免高风险缺口无人接。 */
  owner: string;
  status: 'active' | 'planned';
}

export const GUARDRAIL_CATALOG: GuardrailCatalogEntry[] = [
  {
    id: 'input_prompt_injection',
    layer: 'input',
    stage: 'input_pre_agent',
    action: 'observe',
    coverage: 'code',
    priority: 'P1',
    riskGoal: '识别候选人消息中的提示词套取、角色劫持和忽略指令等注入尝试。',
    source: 'agent/guardrail/input/prompt-injection.service.ts',
    exogenousSignal: 'prompt-injection 模式库（外生检测器）',
    residualRisk: '当前主要是加固与告警，不直接拦截；新型注入话术需持续补样本。',
    verification: 'tests/agent/guardrail/input/prompt-injection.service.spec.ts',
    owner: 'agent-runtime',
    status: 'active',
  },
  {
    id: 'pre_agent_risk_intercept',
    layer: 'input',
    stage: 'input_pre_agent',
    action: 'pause_hosting',
    coverage: 'code',
    priority: 'P0',
    riskGoal: '辱骂、投诉风险、面试结果追问、主动要求转人工等高风险会话进入 Agent 前暂停托管。',
    source: 'agent/guardrail/input/risk-intercept.service.ts',
    exogenousSignal:
      '高置信关键词规则（abuse / complaint_risk / interview_result_inquiry / human_handoff_request / disability_disclosure）',
    residualRisk: '隐晦投诉或无关键词升级仍可能漏检。',
    verification: 'tests/agent/guardrail/input/risk-intercept.service.spec.ts',
    owner: 'agent-runtime',
    status: 'active',
  },
  // ---- tool（真实执行物理留 tools/，guardrail/tool 显式登记） ----
  ...TOOL_GUARDRAIL_CATALOG.map(
    (guardrail): GuardrailCatalogEntry => ({
      ...guardrail,
      layer: 'tool',
    }),
  ),
  // ---- output（rule，确定性，对齐 ground truth） ----
  ...OUTPUT_RULE_CATALOG.map(
    (rule): GuardrailCatalogEntry => ({
      id: rule.id,
      layer: 'output',
      stage: 'output_pre_send',
      action: rule.action,
      coverage: 'code',
      priority: rule.priority,
      riskGoal: rule.riskGoal,
      source: OUTPUT_RULE_SOURCE_BY_ID[rule.id] ?? 'agent/guardrail/output/hard-rules.service.ts',
      exogenousSignal: rule.exogenousSignal,
      residualRisk: rule.residualRisk,
      verification: rule.verification,
      owner: 'agent-runtime',
      status: 'active',
    }),
  ),
];

/** 按层取 catalog 条目（审计/测试用）。 */
export function catalogByLayer(layer: GuardrailLayer): GuardrailCatalogEntry[] {
  return GUARDRAIL_CATALOG.filter((entry) => entry.layer === layer);
}

export const CATALOG_EXPECTED_TOOL_GUARDRAIL_IDS = TOOL_GUARDRAIL_IDS;
export const CATALOG_EXPECTED_OUTPUT_RULE_IDS = OUTPUT_RULE_IDS;
