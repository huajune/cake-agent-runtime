import type {
  GuardrailAction,
  GuardrailCoverage,
  GuardrailPriority,
  GuardrailStage,
} from '@shared-types/guardrail.contract';
import {
  GUARDRAIL_ACTION,
  GUARDRAIL_COVERAGE,
  GUARDRAIL_PRIORITY,
  GUARDRAIL_STAGE,
} from '@shared-types/guardrail.contract';

/**
 * 工具层 Guardrail 显式治理目录。
 *
 * 真实执行逻辑仍在 src/tools/** 内，避免 tools 反向依赖 agent/guardrail 造成分层环；
 * 本文件是 guardrail 模块内的工具层入口，用来集中表达：
 * - 有哪些 tool guardrail；
 * - 对应阶段/动作/优先级/owner；
 * - 真实实现位置与验证证据。
 */
export interface ToolGuardrailCatalogEntry {
  id: string;
  stage: GuardrailStage;
  action: GuardrailAction;
  coverage: GuardrailCoverage;
  priority: GuardrailPriority;
  /** 面向运营/审计/文档的人读中文说明。 */
  description: string;
  riskGoal: string;
  source: string;
  exogenousSignal: string;
  residualRisk: string;
  verification: string;
  owner: string;
  status: 'active' | 'planned';
}

export const TOOL_GUARDRAIL_CATALOG = [
  {
    id: 'booking_jobid_provenance',
    stage: GUARDRAIL_STAGE.TOOL_RUNTIME,
    action: GUARDRAIL_ACTION.REJECT_HARD,
    coverage: GUARDRAIL_COVERAGE.CODE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '报名或预检查时，只允许使用本会话真实查到过的岗位，不能让模型凭空拿 jobId 去约。',
    riskGoal: '预约只能使用本会话真实召回过的岗位，禁止凭空报名。',
    source:
      'tools/duliday-interview-precheck.tool.ts + tools/duliday-interview-booking.tool.ts（isRecalledJobId 闸门）',
    exogenousSignal: '本会话真实召回集 recalledJobIds（ground truth 成员判定）',
    residualRisk: '召回集缓存/会话边界错误会影响判定。',
    verification:
      'tests/tools/tool/duliday-interview-precheck.tool.spec.ts + tests/tools/tool/duliday-interview-booking.tool.spec.ts',
    owner: 'tools-runtime',
    status: 'active',
  },
  {
    id: 'booking_precheck_contract',
    stage: GUARDRAIL_STAGE.TOOL_RUNTIME,
    action: GUARDRAIL_ACTION.REJECT_HARD,
    coverage: GUARDRAIL_COVERAGE.CODE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '正式预约前必须先有本轮 precheck 的可预约结论，不能跳过预检查直接提交 booking。',
    riskGoal: 'booking 必须复用本轮 precheck 的 ready_to_book 结论，禁止绕过 precheck 直接提交。',
    source: 'tools/duliday-interview-booking.tool.ts（prechecked nextAction / missingFieldsCount）',
    exogenousSignal:
      'duliday_interview_precheck.nextAction + bookingChecklist.missingFields.length',
    residualRisk:
      '模型可伪造 prechecked 值，因此 booking 侧仍叠加 jobId、姓名、时段、筛选答案兜底。',
    verification: 'tests/tools/tool/duliday-interview-booking.tool.spec.ts',
    owner: 'tools-runtime',
    status: 'active',
  },
  {
    id: 'booking_real_name',
    stage: GUARDRAIL_STAGE.TOOL_RUNTIME,
    action: GUARDRAIL_ACTION.REJECT_COLLECT,
    coverage: GUARDRAIL_COVERAGE.CODE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '收姓名时拦住昵称、拼音、占位符这些不像中文真名的内容，避免写进报名库。',
    riskGoal: '报名库只接受可用中文真名，昵称/拼音/占位串不入库。',
    source: 'tools/duliday/booking/booking-guards.util.ts（checkRealName）',
    exogenousSignal: '中文真名形态校验（确定性）',
    residualRisk: '少数民族长姓名和罕见姓名需避免误杀，命中后应转人工补录。',
    verification: 'tests/tools/duliday/booking-guards.util.spec.ts',
    owner: 'tools-runtime',
    status: 'active',
  },
  {
    id: 'booking_name_authority',
    stage: GUARDRAIL_STAGE.TOOL_RUNTIME,
    action: GUARDRAIL_ACTION.REJECT_COLLECT,
    coverage: GUARDRAIL_COVERAGE.CODE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '姓名必须来自候选人明确自报或表单，不能把打招呼里的称呼、备注名当真名。',
    riskGoal: '候选人姓名必须来自高置信自陈或表单，不用打招呼昵称顶替。',
    source: 'tools/shared/precheck-core.ts（evaluateBookingNameGate）',
    exogenousSignal: '候选人原文 user_text 出处（"我是X"打招呼昵称负向证据）',
    residualRisk: '多轮姓名指代仍依赖记忆抽取质量。',
    verification: 'tests/tools/shared/precheck-core.spec.ts',
    owner: 'tools-runtime',
    status: 'active',
  },
  {
    id: 'invite_city_provenance',
    stage: GUARDRAIL_STAGE.TOOL_RUNTIME,
    action: GUARDRAIL_ACTION.REJECT_COLLECT,
    coverage: GUARDRAIL_COVERAGE.CODE,
    priority: GUARDRAIL_PRIORITY.P1,
    description:
      '拉群城市必须有据：city 入参要么与会话记忆中的高置信城市一致，要么出现在候选人原文里，不能由模型凭空指定。',
    riskGoal: '防止模型凭空或错误指定城市，把候选人拉进错误城市的兼职群（不可逆副作用）。',
    source: 'tools/shared/invite-city-gate.ts + tools/invite-to-group.tool.ts',
    exogenousSignal: '会话记忆高置信 city 事实 + 候选人本会话原文城市提及（出处判定）',
    residualRisk:
      '候选人原文提及他人城市/曾居城市时仍会放行；跨会话回访客户城市只在长期画像时会被要求重新确认。',
    verification:
      'tests/tools/shared/invite-city-gate.spec.ts + tests/tools/tool/invite-to-group.tool.spec.ts',
    owner: 'tools-runtime',
    status: 'active',
  },
  {
    id: 'booking_screening_answers',
    stage: GUARDRAIL_STAGE.TOOL_RUNTIME,
    action: GUARDRAIL_ACTION.REJECT_HARD,
    coverage: GUARDRAIL_COVERAGE.CODE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '岗位补充筛选题如果已经命中不符合答案，就不允许继续往预约工具提交。',
    riskGoal: '岗位硬筛答案不符合时禁止继续预约。',
    source: 'tools/duliday/booking/booking-guards.util.ts（findScreeningFailure）',
    exogenousSignal: '岗位 supplement label failSignals（ground truth）',
    residualRisk: '岗位补充字段非结构化时依赖标签解析质量。',
    verification: 'tests/tools/duliday/booking-guards.util.spec.ts',
    owner: 'tools-runtime',
    status: 'active',
  },
  {
    id: 'booking_hard_requirements',
    stage: GUARDRAIL_STAGE.TOOL_RUNTIME,
    action: GUARDRAIL_ACTION.REJECT_HARD,
    coverage: GUARDRAIL_COVERAGE.CODE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '候选人参数不满足岗位硬性要求时，工具层直接拒绝提交预约。',
    riskGoal: '报名工具按岗位硬约束拒绝不符合的候选人参数。',
    source: 'tools/duliday/booking/booking-guards.util.ts（性别/健康证硬约束）',
    exogenousSignal: '岗位 policy 派生硬约束 vs 候选人入参',
    residualRisk: '工具层拒绝仍需输出层保证拒绝理由不外露敏感门槛。',
    verification: 'tests/tools/duliday/booking-guards.util.spec.ts',
    owner: 'tools-runtime',
    status: 'active',
  },
] as const satisfies readonly ToolGuardrailCatalogEntry[];

export const TOOL_GUARDRAIL_IDS = TOOL_GUARDRAIL_CATALOG.map((entry) => entry.id);
