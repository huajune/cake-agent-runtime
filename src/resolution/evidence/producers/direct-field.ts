import { CANDIDATE_CLAIM_FIELDS, type CandidateFactClaim } from '../claim.types';
import { deriveFieldValueFromQuote } from '../normalize';

/**
 * 规则 producer（方案 §9 direct-field-claim.producer）：对候选人原文逐条做
 * 确定性字段解析，输出 producer='rule' 的 claim。
 *
 * 与 candidate-field-parser.parseCandidateFieldsFromText 的差异：那边把全部
 * 消息拼接后解析（HC-2 CollectedField 形态，无逐条锚定）；这里逐条消息解析，
 * quote 精确锚到命中的那条消息——同字段多条命中时全部产出，由裁决器按
 * "最新者胜"归并，天然实现"当前轮明确自报覆盖会话早先自报"（方案 §5.1）。
 *
 * isStudent 刻意不在此处理：自由聊天里的身份识别有独立状态机（确认问答/
 * 二选一/改口核实），由 identity-claim.producer 包装唯一识别器产出。
 */

const DIRECT_FIELDS = CANDIDATE_CLAIM_FIELDS.filter((field) => field !== 'isStudent');

/**
 * quote 上限：**先截断再解析**，推导输入必须与存下来的证据完全一致，否则本轨会产出
 * 自己都通不过公证的 claim。
 *
 * 生产实测（2026-08-06，chat 6a714c00）：旧实现全文推导、按 200 字截断存 quote，
 * 一条 442 字消息里位于截断点之后的年龄信号因此被拒。上限抬到 1000 字覆盖长表单
 * 与长图片描述，超限部分不参与解析。
 */
export const RULE_CLAIM_QUOTE_MAX_CHARS = 1000;

export interface ProduceDirectClaimsParams {
  /** 候选人消息文本（剥引用块/时间后缀后），按会话顺序排列。 */
  candidateTexts: readonly string[];
  assertedAt: string;
  now?: Date;
}

export function produceDirectFieldClaims(params: ProduceDirectClaimsParams): CandidateFactClaim[] {
  const now = params.now ?? new Date();
  const claims: CandidateFactClaim[] = [];
  let sequence = 0;

  for (const [messageIndex, text] of params.candidateTexts.entries()) {
    // 推导输入即存储证据：先截断再推导，保证裁决器复算必然成功。
    const quote = text.trim().slice(0, RULE_CLAIM_QUOTE_MAX_CHARS);
    if (!quote) continue;
    for (const field of DIRECT_FIELDS) {
      const value = deriveFieldValueFromQuote(field, quote, now);
      if (value === null) continue;
      claims.push({
        claimId: `rule_${field}_${(sequence += 1)}`,
        field,
        value,
        operation: 'set',
        producer: 'rule',
        interpretation: 'direct',
        evidence: { quote, messageIndex },
        assertedAt: params.assertedAt,
      });
    }
  }
  return claims;
}
