import type { CandidateClaimRejectionReason, CandidateFactClaim } from './claim.types';
import { CANDIDATE_FIELD_RISK, MIN_QUOTE_CONTEXT_CHARS } from './policies';
import { isValidCandidateFieldShape, normalizedIncludes } from './normalize';

/**
 * 候选人事实**公证器**（宪法 P11）。
 *
 * 定位：**代价路由器，不是真值裁判**——不回答"这个值真不真"（那个法庭在系统外），
 * 只回答"出处站不站得住"。判据不是准确率，是每种错法都有便宜出口：误拒→模型本轮
 * 换引文重试；误疑→多问一句；误收→报名级确认流兜底（D3）。
 *
 * 三问，每问全封闭（两边都是已知字符串，纯比对/长度/查表，无语义推断）：
 *   ① 引文真伪 ② 值形状 ③ 出处存疑（回声·短引文，只转确认不判错）
 *
 * **不做什么**：不复算值、不按产者排信任、不因"正则推不出这个值"而否决。
 */

export type NotaryOutcome = 'pass' | 'reject' | 'needs_confirmation';

export interface NotaryVerdict {
  outcome: NotaryOutcome;
  reason?: CandidateClaimRejectionReason;
  /** 排障用的人类可读说明；不进 PII 观测事件。 */
  detail?: string;
}

const PASS: NotaryVerdict = { outcome: 'pass' };

/**
 * 第一问·引文真伪：quote 必须在候选人可作证语料里逐字命中。反编造主力——模型编不出
 * 一段真实存在过的原话。
 *
 * 严格身份字段（name/phone）追加一条仍属字符串包含的检查：值本体必须落在 quote 内，
 * 失联即视为没有出处。手机号忽略空格/横线。
 */
export function verifyQuoteProvenance(
  claim: CandidateFactClaim,
  candidateTexts: readonly string[],
): NotaryVerdict {
  const quote = claim.evidence.quote.trim();
  if (!quote) {
    return { outcome: 'reject', reason: 'quote_not_found', detail: '证据文本为空' };
  }
  if (!candidateTexts.some((text) => normalizedIncludes(text, quote))) {
    return { outcome: 'reject', reason: 'quote_not_found', detail: 'quote 未出现在候选人原文' };
  }

  // clear 是显式清除操作，不携带值，值-引文关系无从谈起。
  if (claim.operation === 'clear') return PASS;

  if (CANDIDATE_FIELD_RISK[claim.field] !== 'strict_identity') return PASS;

  // 确认式 claim 的值本体在 Agent 问句里（"张伟对吧？"→"对"），此时以问句为基准。
  const evidenceText =
    claim.interpretation === 'context_confirmation' && claim.evidence.agentQuestionQuote
      ? claim.evidence.agentQuestionQuote
      : quote;
  const value = String(claim.value ?? '').trim();
  // 与上面的语料命中同口径（NFKC + 折空白，不折标点）：语料那步已经折过空白，这步
  // 却用裸 includes 的话，候选人打「我叫王 玥」会被自己人误拒。
  const digitsOf = (text: string): string => text.normalize('NFKC').replace(/\D/g, '');
  const phoneDigits = digitsOf(value);
  const contained =
    claim.field === 'phone'
      ? phoneDigits.length > 0 && digitsOf(evidenceText).includes(phoneDigits)
      : normalizedIncludes(evidenceText, value);
  if (!contained) {
    return {
      outcome: 'reject',
      reason: 'quote_not_found',
      detail: `严格身份字段 ${claim.field} 的引文未逐字含该值`,
    };
  }
  return PASS;
}

/** 第二问·值形状（A5 函数族的唯一裁决用途）。 */
export function verifyValueShape(claim: CandidateFactClaim): NotaryVerdict {
  if (claim.operation === 'clear') return PASS;
  if (isValidCandidateFieldShape(claim.field, claim.value)) return PASS;
  return {
    outcome: 'reject',
    reason: 'invalid_value_shape',
    detail: `值形状非法: ${String(claim.value)}`,
  };
}

/**
 * 第三问之一·短引文门（C5）：防裸「有」退化——只有一个「有」字时，它可以是"有健康证"
 * "有经验""有时间"任何一问的答案，引文虽真却不指向任何字段。
 *
 * 两个豁免：`context_confirmation` 带问句时语境由问句提供（收紧会重造确认死锁）；
 * 严格身份字段的长度约束已由第一问的值包含给出（否则打死 badcase 6a7446eb 的裸名直答）。
 */
export function verifyQuoteContext(claim: CandidateFactClaim): NotaryVerdict {
  if (claim.operation === 'clear') return PASS;
  if (
    claim.interpretation === 'context_confirmation' &&
    claim.evidence.agentQuestionQuote?.trim()
  ) {
    return PASS;
  }
  if (CANDIDATE_FIELD_RISK[claim.field] === 'strict_identity') return PASS;

  const minContext = MIN_QUOTE_CONTEXT_CHARS[claim.field];
  if (minContext <= 0) return PASS;

  const quoteLength = claim.evidence.quote.trim().replace(/\s+/gu, '').length;
  const valueLength = String(claim.value ?? '').trim().length;
  // 值本体落在 quote 里时按"值 + 语境"要求；不落在里面（归一化产物，如"一米六三"→163）
  // 时只要求语境字数本身，否则数字位数会凭空抬高门槛。
  const valueInQuote = claim.evidence.quote.includes(String(claim.value ?? '').trim());
  const required = (valueInQuote ? valueLength : 0) + minContext;
  if (quoteLength >= required) return PASS;
  return {
    outcome: 'reject',
    reason: 'quote_too_short',
    detail: `${claim.field} 引文过短（${quoteLength} < ${required}），脱离语境无法判定其指向本字段`,
  };
}

/** 回声检查的最短生效长度：短于此的字符串在双方文本里同现属巧合，不构成回声。 */
const ECHO_MIN_QUOTE_CHARS = 4;

/**
 * 第三问之二·回声检查（C4）：模型把**我方自己写的字**当候选人自陈提交（苏海龙岗位卡
 * 回声）。第一问看不出问题——那段文字确实出现在 user 消息里。
 *
 * quote 同时命中 Agent 已发消息全集 → 出处存疑，转确认不判错。短于
 * ECHO_MIN_QUOTE_CHARS 的不参与："男""24"在双方文本同现是必然，判回声会打死正常自陈。
 */
export function detectAgentEcho(
  claim: CandidateFactClaim,
  assistantTexts: readonly string[],
): NotaryVerdict {
  const quote = claim.evidence.quote.trim();
  if (quote.replace(/\s+/gu, '').length < ECHO_MIN_QUOTE_CHARS) return PASS;
  if (!assistantTexts.some((text) => normalizedIncludes(text, quote))) return PASS;
  return {
    outcome: 'needs_confirmation',
    reason: 'quote_echoes_agent_message',
    detail: '引文同时命中我方已发消息，疑似岗位卡/收资模板回声，需候选人确认',
  };
}

export interface NotarizeParams {
  claim: CandidateFactClaim;
  /** 候选人可作证语料（extractCandidateTexts 产物）。 */
  candidateTexts: readonly string[];
  /** 我方已发消息全集，回声检查基准。 */
  assistantTexts: readonly string[];
  /**
   * 回声检查是否参与裁决。shadow 期只观测不改行为（迁移三阶段 P0），
   * 切换后回声路由 needs_confirmation。
   */
  echoRoutesToConfirmation?: boolean;
}

export interface NotarizeResult {
  verdict: NotaryVerdict;
  /** 回声检查的独立结论；shadow 期用于观测误报率（判据④）。 */
  echo: NotaryVerdict;
}

/**
 * 三问串行公证。任一问不过即短路——出口按 `outcome` 分流：
 * reject 交模型重试，needs_confirmation 交候选人终审。
 */
export function notarizeCandidateClaim(params: NotarizeParams): NotarizeResult {
  const echo = detectAgentEcho(params.claim, params.assistantTexts);

  for (const verdict of [
    verifyQuoteProvenance(params.claim, params.candidateTexts),
    verifyValueShape(params.claim),
    verifyQuoteContext(params.claim),
  ]) {
    if (verdict.outcome !== 'pass') return { verdict, echo };
  }

  if (params.echoRoutesToConfirmation && echo.outcome !== 'pass') {
    return { verdict: echo, echo };
  }
  return { verdict: PASS, echo };
}
