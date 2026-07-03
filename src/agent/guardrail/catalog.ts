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
  brand_alias_fuzzy_match_ignored:
    'agent/guardrail/output/rules/brand-name-errors.rule.ts（HardRulesService 调度）',
  confirmed_booking_onsite_script_missing:
    'agent/guardrail/output/rules/booking-claim-errors.rule.ts（HardRulesService 调度）',
  confirmed_booking_time_missing:
    'agent/guardrail/output/rules/booking-claim-errors.rule.ts（HardRulesService 调度）',
  district_level_distance_claim:
    'agent/guardrail/output/rules/location-claim-errors.rule.ts（HardRulesService 调度）',
  farther_job_recommended:
    'agent/guardrail/output/rules/job-fact-hallucinations.rule.ts（HardRulesService 调度）',
  geocode_ambiguous_candidates_omitted:
    'agent/guardrail/output/rules/location-claim-errors.rule.ts（HardRulesService 调度）',
  group_invite_without_reason:
    'agent/guardrail/output/rules/group-invite-context.rule.ts（HardRulesService 调度）',
  hourly_salary_value_mismatch:
    'agent/guardrail/output/rules/job-fact-value-mismatch.rule.ts（HardRulesService 调度）',
  human_service_phrase_leak:
    'agent/guardrail/output/rules/internal-info-leaks.rule.ts（HardRulesService 调度）',
  image_description_not_saved:
    'agent/guardrail/output/rules/visual-message-errors.rule.ts（HardRulesService 调度）',
  job_shift_polarity_mismatch:
    'agent/guardrail/output/rules/job-fact-value-mismatch.rule.ts（HardRulesService 调度）',
  provided_booking_fields_ignored:
    'agent/guardrail/output/rules/context-priority-errors.rule.ts（HardRulesService 调度）',
  repeated_greeting: 'agent/guardrail/output/rules/repeated-reply.rule.ts（HardRulesService 调度）',
  repeated_reply: 'agent/guardrail/output/rules/repeated-reply.rule.ts（HardRulesService 调度）',
  requested_brand_mismatch:
    'agent/guardrail/output/rules/brand-name-errors.rule.ts（HardRulesService 调度）',
  schedule_filtered_job_recommended:
    'agent/guardrail/output/rules/job-fact-hallucinations.rule.ts（HardRulesService 调度）',
  settlement_cycle_mismatch:
    'agent/guardrail/output/rules/job-fact-value-mismatch.rule.ts（HardRulesService 调度）',
  wait_notice_time_collection:
    'agent/guardrail/output/rules/booking-claim-errors.rule.ts（HardRulesService 调度）',
  age_requirement_disclosure:
    'agent/guardrail/output/rules/discrimination-leaks.rule.ts（HardRulesService 调度）',
  booking_form_field_mismatch:
    'agent/guardrail/output/rules/booking-claim-errors.rule.ts（HardRulesService 调度）',
  brand_name_violation:
    'agent/guardrail/output/rules/brand-name-errors.rule.ts（HardRulesService 调度）',
  candidate_name_echo:
    'agent/guardrail/output/rules/candidate-name-echo.rule.ts（HardRulesService 调度）',
  discriminatory_screening_leak:
    'agent/guardrail/output/rules/discrimination-leaks.rule.ts（HardRulesService 调度）',
  distance_missing:
    'agent/guardrail/output/rules/job-fact-hallucinations.rule.ts（HardRulesService 调度）',
  gender_direct_reject:
    'agent/guardrail/output/rules/discrimination-leaks.rule.ts（HardRulesService 调度）',
  geocode_uncertain_location_claim:
    'agent/guardrail/output/rules/location-claim-errors.rule.ts（HardRulesService 调度）',
  group_full_without_invite:
    'agent/guardrail/output/rules/false-promises.rule.ts（HardRulesService 调度）',
  group_promise_without_invite:
    'agent/guardrail/output/rules/false-promises.rule.ts（HardRulesService 调度）',
  handoff_no_booking_claim:
    'agent/guardrail/output/rules/booking-claim-errors.rule.ts（HardRulesService 调度）',
  internal_output_leak:
    'agent/guardrail/output/rules/internal-info-leaks.rule.ts（HardRulesService 调度）',
  precheck_blocked_booking_claim:
    'agent/guardrail/output/rules/booking-claim-errors.rule.ts（HardRulesService 调度）',
  proactive_insurance_policy_mention:
    'agent/guardrail/output/rules/insurance-policy-claims.rule.ts（HardRulesService 调度）',
  quota_promise: 'agent/guardrail/output/rules/false-promises.rule.ts（HardRulesService 调度）',
  salary_fabrication:
    'agent/guardrail/output/rules/job-fact-hallucinations.rule.ts（HardRulesService 调度）',
  system_status_fabrication:
    'agent/guardrail/output/rules/false-promises.rule.ts（HardRulesService 调度）',
  tool_failure_success_claim:
    'agent/guardrail/output/rules/false-promises.rule.ts（HardRulesService 调度）',
  ungrounded_job_recommendation:
    'agent/guardrail/output/rules/job-fact-hallucinations.rule.ts（HardRulesService 调度）',
  wait_notice_time_fabrication:
    'agent/guardrail/output/rules/booking-claim-errors.rule.ts（HardRulesService 调度）',
  work_content_generalization:
    'agent/guardrail/output/rules/job-fact-hallucinations.rule.ts（HardRulesService 调度）',
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
    riskGoal: '辱骂、投诉风险、面试结果追问等高风险会话进入 Agent 前暂停托管。',
    source: 'agent/guardrail/input/risk-intercept.service.ts',
    exogenousSignal: '高置信关键词规则（abuse / complaint_risk / interview_result_inquiry）',
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
  // ---- output（llm 档，高风险才触发，强模型） ----
  {
    id: 'output_llm_reviewer',
    layer: 'output',
    stage: 'output_pre_send',
    action: 'revise',
    coverage: 'code',
    priority: 'P1',
    riskGoal: '对规则无法表达的高风险语义、事实接地和话术问题做强模型复核。',
    source:
      'agent/guardrail/output/llm/semantic-reviewer.service.ts（OutputGuardrailService 组合器调度）',
    exogenousSignal: 'toolCalls.result + memory + redLines（接地才有信号）',
    residualRisk: '默认由 OUTPUT_GUARDRAIL_LLM_ENABLED 灰度控制；关闭时只剩确定性 rule 档。',
    verification: 'tests/agent/guardrail/output/output-guardrail.service.spec.ts',
    owner: 'agent-runtime',
    status: 'active',
  },
];

/** 按层取 catalog 条目（审计/测试用）。 */
export function catalogByLayer(layer: GuardrailLayer): GuardrailCatalogEntry[] {
  return GUARDRAIL_CATALOG.filter((entry) => entry.layer === layer);
}

export const CATALOG_EXPECTED_TOOL_GUARDRAIL_IDS = TOOL_GUARDRAIL_IDS;
export const CATALOG_EXPECTED_OUTPUT_RULE_IDS = OUTPUT_RULE_IDS;
