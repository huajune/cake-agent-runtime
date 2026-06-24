/**
 * Guardrail 统一目录（可审计登记表）。
 *
 * 治理价值（§2.5）：逐条审计"每个 guardrail 带不带**新外生信号**"——只读同样信息再想
 * 一遍的 reviewer 在决策论上被中心化决策者支配，堆多了准确率反而崩。这里把现有/规划中的
 * guardrail 登记成一张表，`exogenousSignal` 字段是审计抓手；`source` 标注物理位置
 * （tool guardrail 因分层物理留 tools/，仅在此登记引用，不反向依赖 agent）。
 *
 * 注意：本目录是**登记/审计**用途，不在此执行 guardrail（执行仍在各自的 in-loop / 出站
 * 调用点）。物理目录归并（input-guard/reply-fact-guard/risk-intercept 迁入 agent/guardrail/）
 * 属纯搬家，待后续低风险窗口做；本表先把契约与审计落地。
 */

import type { GuardrailLayer } from '@shared-types/guardrail.contract';

export interface GuardrailCatalogEntry {
  /** 稳定 id（rule id / service 名）。 */
  id: string;
  layer: GuardrailLayer;
  /** 物理位置（文件/服务）。 */
  source: string;
  /** 该 guardrail 对齐/带入的"新外生信号"——审计核心字段。 */
  exogenousSignal: string;
  status: 'active' | 'planned';
}

export const GUARDRAIL_CATALOG: readonly GuardrailCatalogEntry[] = [
  // ---- input ----
  {
    id: 'input_prompt_injection',
    layer: 'input',
    source: 'agent/input-guard.service.ts',
    exogenousSignal: 'prompt-injection 模式库（外生检测器）',
    status: 'active',
  },
  {
    id: 'pre_agent_risk_intercept',
    layer: 'input',
    source: 'channels/wecom/.../reply-workflow（preAgentRiskIntercept）',
    exogenousSignal: 'conversation-risk 高危关键词信号',
    status: 'active',
  },
  // ---- tool（物理留 tools/，仅登记） ----
  {
    id: 'booking_jobid_provenance',
    layer: 'tool',
    source: 'tools/duliday-interview-booking.tool.ts（isRecalledJobId 闸门）',
    exogenousSignal: '本会话真实召回集 recalledJobIds（ground truth 成员判定）',
    status: 'active',
  },
  {
    id: 'booking_real_name',
    layer: 'tool',
    source: 'tools/duliday/booking/booking-guards.util.ts（checkRealName）',
    exogenousSignal: '中文真名形态校验（确定性）',
    status: 'active',
  },
  {
    id: 'booking_name_authority',
    layer: 'tool',
    source: 'tools/shared/precheck-core.ts（evaluateBookingNameGate）',
    exogenousSignal: '候选人原文 user_text 出处（"我是X"打招呼昵称负向证据）',
    status: 'active',
  },
  {
    id: 'booking_screening_answers',
    layer: 'tool',
    source: 'tools/duliday/booking/booking-guards.util.ts（findScreeningFailure）',
    exogenousSignal: '岗位 supplement label failSignals（ground truth）',
    status: 'active',
  },
  {
    id: 'booking_hard_requirements',
    layer: 'tool',
    source: 'tools/duliday/booking/booking-guards.util.ts（性别/健康证硬约束）',
    exogenousSignal: '岗位 policy 派生硬约束 vs 候选人入参',
    status: 'active',
  },
  // ---- output（rule，确定性，对齐 ground truth） ----
  {
    id: 'discriminatory_screening_leak',
    layer: 'output',
    source: 'channels/wecom/.../reply-fact-guard.service.ts',
    exogenousSignal: '歧视筛选词词库（block）',
    status: 'active',
  },
  {
    id: 'group_promise_without_invite',
    layer: 'output',
    source: 'reply-fact-guard.service.ts',
    exogenousSignal: '本轮 invite_to_group 是否成功（toolCalls.result 接地）',
    status: 'active',
  },
  {
    id: 'salary_fabrication',
    layer: 'output',
    source: 'reply-fact-guard.service.ts',
    exogenousSignal: '岗位数据里的薪资字段（ground truth）',
    status: 'active',
  },
  {
    id: 'booking_form_field_mismatch',
    layer: 'output',
    source: 'reply-fact-guard.service.ts',
    exogenousSignal: 'precheck.requiredFieldsToCollectNow（ground truth）',
    status: 'active',
  },
  {
    id: 'proactive_insurance_policy_mention',
    layer: 'output',
    source: 'reply-fact-guard.service.ts',
    exogenousSignal: '岗位用工形式=兼职（ground truth）',
    status: 'active',
  },
  // ---- output（规划中） ----
  {
    id: 'candidate_name_echo',
    layer: 'output',
    source: 'reply-fact-guard.service.ts（PR-D）',
    exogenousSignal: 'contactName（候选人昵称，ground truth）',
    status: 'planned',
  },
  {
    id: 'distance_missing',
    layer: 'output',
    source: 'reply-fact-guard.service.ts（PR-D）',
    exogenousSignal: '岗位推荐结构是否带公里数（ground truth）',
    status: 'planned',
  },
  {
    id: 'output_llm_reviewer',
    layer: 'output',
    source: 'agent/guardrail/output/llm-reviewer.service.ts（PR-D）',
    exogenousSignal: 'toolCalls.result + 岗位数据 + memory（接地才有信号）',
    status: 'planned',
  },
];

/** 按层取 catalog 条目（审计/测试用）。 */
export function catalogByLayer(layer: GuardrailLayer): GuardrailCatalogEntry[] {
  return GUARDRAIL_CATALOG.filter((entry) => entry.layer === layer);
}
