import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

const INSURANCE_POLICY_TERM_PATTERN = /保险|社保|五险(?:一金)?|意外险|雇主责任险/;

/**
 * 保险/社保主动提及规则。
 *
 * 职责：
 * - 管“候选人本轮没问，但 Agent 主动提保险/社保/五险/意外险/雇主责任险”的场景；
 * - 兼职岗位字段里的“保险”多指雇主责任险/意外险，候选人容易理解成社保/五险；
 * - 这在业务中属于敏感用工政策承诺，发出去就会形成聊天证据，所以命中直接 block。
 *
 * 不负责：
 * - 候选人本轮主动问了保险/社保时，这里不拦，后续应由业务 prompt/人工口径回答；
 * - 不判断岗位实际是否提供保险，也不解析 jobSalary/benefits 字段。
 *
 * 维护边界：
 * - 如果新增政策词（如公积金、商业险）需要同等收敛，补到 INSURANCE_POLICY_TERM_PATTERN。
 *
 * 跨轮豁免：候选人可能上轮问"交社保吗"、Agent 先反问门店、本轮才作答——此时本轮
 * userMessage（如"第一个"）不含保险词，但这仍是"候选人问、Agent 答"，不是主动外抛。
 * 因此近几轮候选人消息（recentUserTexts）任一提到保险词即豁免。
 */
export function detectProactiveInsurancePolicyMention(
  text: string,
  userMessage?: string,
  recentUserTexts?: string[],
) {
  // reply 没有保险政策词时直接放行。
  if (!INSURANCE_POLICY_TERM_PATTERN.test(text)) return null;
  // 候选人本轮主动提问，说明不是 Agent 主动外抛政策点。
  if (userMessage && INSURANCE_POLICY_TERM_PATTERN.test(userMessage)) return null;
  // 候选人近几轮提过保险/社保：本轮回复视为对候选人问题的作答，放行。
  if (recentUserTexts?.some((m) => INSURANCE_POLICY_TERM_PATTERN.test(m))) return null;

  return {
    ruleId: 'proactive_insurance_policy_mention',
    label:
      '候选人本轮未主动询问保险/社保，但回复主动提及保险/社保/五险等敏感政策（兼职保险易被误解为社保/五险，需拦截）',
    action: GUARDRAIL_ACTION.BLOCK,
    blocked: true,
  };
}
