import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * Agent 回复输出泄漏检测。
 *
 * 业务背景：badcase `vllg7hlu` 中，模型直接给候选人发送了 `阶段已切换到 job_consultation，
 * 等待候选人回复年龄信息。`，把内部程序记忆术语暴露给用户。Prompt 已写过
 * "严禁暴露阶段切换"，但模型偶尔违反，必须在出站 guardrail 做确定性兜底。
 *
 * 职责：
 * - 管阶段名、工具名、内部策略字段、JSON/代码块等“实现细节被发给候选人”的问题；
 * - 这些内容不依赖业务工具是否成功，只要出现在最终 reply 就应拦截；
 * - 命中后 block，因为用户看到内部状态会破坏产品可信度，也可能泄露策略。
 *
 * 不负责：
 * - 不管候选人是否问到了业务事实；
 * - 不管岗位/预约/位置的事实正确性，那些由其它领域规则对账。
 *
 * 维护边界：
 * - 新增阶段字段、工具名、内部 prompt 字段时，应同步补 STAGE_TERMS 或 TOOL_NAMES；
 * - 如果某个工具名未来变成候选人可见品牌词，需要先在产品口径里明确，再从这里移除。
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
  // 工具链结束后把“已经对候选人完成动作”的内部状态当成回复
  /(?:已发送岗位推荐|已给出岗位信息|岗位推荐已发送)[，,。；;\s]*(?:现在)?等待候选人(?:回应|回复|确认)/,
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

/**
 * 返回命中的 pattern，方便告警里展示具体泄漏形态。
 * 这里不返回 RuleContradiction，是为了让 hard-rules.service 统一决定 action 和告警格式。
 */
export function detectOutputLeak(content: string): RegExp | null {
  if (!content) return null;
  for (const pattern of PATTERNS) {
    if (pattern.test(content)) return pattern;
  }
  return null;
}

/**
 * 人设露馅：Agent 人设是真人招募经理，说"转人工/人工客服"等词等于自曝机器人身份。
 *
 * 运营反馈（recvjXBkmV6idz"能不能不要说转人工，这样不是露馅了吗"、
 * recvnV3iYGZnBJ"别说我给你转人工，有点像人机"）。正确口径是"我帮你问下同事/
 * 让负责的同事联系你"。与上面的内部状态泄漏同族（实现细节外露），但先 observe
 * 收判例——话术类拦截要先确认误报率再升档。
 */
const HUMAN_SERVICE_PHRASE_PATTERN = /转人工|人工客服|人工坐席|转接人工|人工渠道/;

export function detectHumanServicePhraseLeak(content: string): RuleContradiction | null {
  if (!content) return null;
  if (!HUMAN_SERVICE_PHRASE_PATTERN.test(content)) return null;
  return {
    ruleId: 'human_service_phrase_leak',
    label:
      '回复出现"转人工/人工客服"等表述，与真人招募经理人设冲突（badcase recvjXBkmV6idz / recvnV3iYGZnBJ），应改为"帮你问下同事"类口径',
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}
