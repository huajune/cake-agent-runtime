import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { splitClaimSentences } from './claim-assertion.util';

const INSURANCE_POLICY_TERM_PATTERN = /保险|社保|五险(?:一金)?|意外险|雇主责任险/;

/**
 * 任职要求语境：岗位把"社保证明/劳动合同"当作应聘门槛（典型是"第二职业"类岗位要求
 * 提供第一份工作的社保证明），此时提社保是资格预筛，不是福利承诺。
 * 上线首日误伤（2026-07-03 青岛哈根达斯单）：Agent 问"需要提供劳动合同和社保证明，
 * 你有交本地社保的工作吗"被当成主动外抛政策拦截。
 *
 * 豁免必须锚定在"提供/出示 + 证明材料"的动宾结构或"你有交社保吗"的资格提问上，
 * 不能用"合同/证明/材料"裸词：中文招聘话术里"签合同交五险一金"是最常见的主动福利
 * 承诺组合，裸词豁免会把这条 P0 规则要拦的典型场景整句放行（PR #421 review）。
 */
// 2026-07-06 守卫档案 id=80/97 补漏：岗位要求行常是名词短语式（"需第一职业劳动合同及社保"
// "要求有本地社保和劳动合同"），没有"提供/出示"动词也没有"证明"字样，原豁免接不住，
// 导致第二职业类岗位（哈根达斯）的推荐永远被 P0 拦死。新增三个锚：
// - "第一职业"（与"第二职业"同为该岗位类型的强信号词，福利承诺话术不会出现）；
// - "需/要求 + 提供/出示/有/持有 + 社保/保险/劳动合同"（要求动词 + 持有动词双锚，
//   "签合同交五险一金"这类福利承诺不含要求动词，仍拦）；
// - "劳动合同 及/和/与/+ 社保"并列结构（要求行专属搭配）。
const REQUIREMENT_CONTEXT_PATTERN =
  /(?:提供|出示|提交|准备|带上?)[^。！？\n]{0,12}(?:证明|材料|合同)|(?:证明|材料|合同)[^。！？\n]{0,6}(?:提供|出示|提交|准备)|第二职业|第一职业|(?:需|须|需要|要求)(?:提供|出示|有|持有?)[^。！？\n]{0,8}(?:社保|保险|劳动合同)|(?:劳动)?合同[^。！？\n]{0,4}[及和与+][^。！？\n]{0,6}(?:社保|保险)|(?:社保|保险)[^。！？\n]{0,4}[及和与+][^。！？\n]{0,6}(?:劳动)?合同|(?:你|您)[^。！？\n]{0,4}有[^。！？\n]{0,8}(?:交|缴|买)[^。！？\n]{0,8}(?:社保|保险)/;

// 切句直接用 claim-assertion.util 的共享原语：此前本地实现把 ？丢弃、与共享口径
// 悄悄分叉（2026-07-06 review），删除本地版防止再漂移。

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
  // 每一句含保险词的句子都处于任职要求语境（社保证明/劳动合同/第二职业门槛）时放行：
  // 这是资格预筛必须问的问题，不是福利承诺。只要有一句是纯福利性提及仍拦截。
  const policySentences = splitClaimSentences(text).filter((s) =>
    INSURANCE_POLICY_TERM_PATTERN.test(s),
  );
  if (
    policySentences.length > 0 &&
    policySentences.every((s) => REQUIREMENT_CONTEXT_PATTERN.test(s))
  ) {
    return null;
  }

  return {
    ruleId: 'proactive_insurance_policy_mention',
    label:
      '候选人本轮未主动询问保险/社保，但回复主动提及保险/社保/五险等敏感政策（兼职保险易被误解为社保/五险，需拦截）',
    action: GUARDRAIL_ACTION.BLOCK,
    blocked: true,
  };
}
