import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 候选人昵称直呼检测。
 *
 * 职责：
 * - 管“reply 直接用企微备注/contactName 里的姓名或昵称称呼候选人”的问题；
 * - 企微备注可能来自运营内部标注，不一定是候选人愿意被叫的真实称呼；
 * - 当前为 observe，用于发现模型是否在复读备注名，暂不阻断业务回复。
 *
 * 不负责：
 * - 不做 PII 全量识别，例如手机号、身份证号等；
 * - 不判断候选人自己消息里是否主动说了姓名，目前只对 contactName 做轻量对账。
 *
 * 维护边界：
 * - 这里只检查问候语位置的 2-6 字 token，避免普通正文词和备注名重合导致误报；
 * - 如果未来需要 block，应先接入“候选人自称姓名”的豁免信号。
 */
export function detectCandidateNameEcho(
  text: string,
  contactName?: string,
): RuleContradiction | null {
  // 清理控制字符和多余空白，避免企微备注里的隐藏字符影响包含判断。
  const cleaned = contactName
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  // 只看直接称呼候选人的开场/问候形态，降低把正文里的普通词当昵称的概率。
  const vocatives = [
    /([一-龥A-Za-z]{2,6})\s*[，,]?\s*(?:你好|您好|在吗)/,
    /(?:你好|您好)[，,]?\s*([一-龥A-Za-z]{2,6})/,
    /\bhi[, ]\s*([一-龥A-Za-z]{2,6})/i,
  ];
  for (const re of vocatives) {
    const token = re.exec(text)?.[1]?.trim();
    // token 至少 2 个字符，且必须包含在企微备注中，才认为是备注昵称回显。
    if (token && token.length >= 2 && cleaned.includes(token)) {
      return {
        ruleId: 'candidate_name_echo',
        label: `回复疑似用候选人昵称/姓名直接称呼（"${token}" 命中企微备注），禁止称呼候选人昵称（51 条 candidate_name_echo）`,
        action: GUARDRAIL_ACTION.OBSERVE,
      };
    }
  }
  return null;
}
