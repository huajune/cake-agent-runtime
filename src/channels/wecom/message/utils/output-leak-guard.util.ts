/**
 * Agent 回复输出泄漏检测。
 *
 * 业务背景：badcase `vllg7hlu` 中，模型直接给候选人发送了 `阶段已切换到 job_consultation，
 * 等待候选人回复年龄信息。`，把内部程序记忆术语暴露给用户。Prompt 已写过
 * "严禁暴露阶段切换"（candidate-consultation.md L116），但模型偶尔违反，必须在
 * 投递层做最后一道兜底。
 *
 * 命中后的处理由调用方决定（当前策略：静默丢弃整条回复，不重试，不告警）。
 */

const STAGE_TERMS = [
  '阶段已切换',
  '阶段切换到',
  '阶段推进到',
  '当前阶段策略',
  '阶段成功标准',
  'effectiveStageStrategy',
  'nextStage',
  'currentStage',
  'fromStage',
  'disallowedActions',
  'successCriteria',
  'primaryGoal',
] as const;

const TOOL_NAMES = [
  'advance_stage',
  'duliday_job_list',
  'duliday_interview_precheck',
  'duliday_interview_booking',
  'invite_to_group',
  'request_handoff',
  'skip_reply',
  'raise_risk_alert',
  'geocode',
  'recall_history',
  'save_image_description',
  'send_store_location',
] as const;

const PATTERNS: RegExp[] = [
  // 模型把阶段术语 / 内部状态字段直接说出来
  new RegExp(STAGE_TERMS.map(escapeRegex).join('|')),
  // 等待候选人补 X 信息（典型阶段切换回声）
  /等待候选人(?:回复|提供|补充|确认)\S*信息/,
  // 工具调用回显
  new RegExp(`(?:调用|call|invoke)\\s*(?:${TOOL_NAMES.map(escapeRegex).join('|')})`, 'i'),
  // 工具结果 JSON 残片直接外抛（{"success":true,...}）
  /["']success["']\s*:\s*(?:true|false)/,
  // 代码块（Agent 不应该给候选人发 markdown code fence）
  /^```/m,
];

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectOutputLeak(content: string): RegExp | null {
  if (!content) return null;
  for (const pattern of PATTERNS) {
    if (pattern.test(content)) return pattern;
  }
  return null;
}
