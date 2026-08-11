import type { AdjudicatedClaim, CandidateClaimField, CandidateFactClaim } from './claim.types';
import { validateClaimValueAgainstQuote } from './policies';
import {
  candidateValuesEquivalent,
  deriveFieldValueFromQuote,
  normalizedIncludes,
} from './normalize';
import { RULE_CLAIM_QUOTE_MAX_CHARS } from './producers/direct-field';
import {
  buildEffectiveProfile,
  type EffectiveCandidateProfile,
  type ProfileHintFacts,
  type SessionAcceptedFacts,
} from './profile';

/**
 * 候选人事实裁决器（方案 §5/§6.2 的收口本体）。
 *
 * 纯函数、零 LLM、零 IO——工具（precheck/booking）是纯函数 builder，裁决器保持
 * 同形态以便直接调用与穷举测试。所有验证都是确定性的：
 *
 * 1. 出处验证：claim.evidence.quote 必须在候选人消息文本集（剥装饰后）中子串命中；
 * 2. 值验证：按字段风险策略复算（strict 逐字含 / normalizable 确定性推导等价）；
 * 3. 归并：同字段多条有效 claim——值等价则最新者胜（先前的标 superseded），
 *    值冲突则整字段判 conflicted（宁可要求重新确认，不静默二选一）；
 * 4. legacy 裸值（模型旧入参转译、无 quote）：在候选人全文里能确定性推导出
 *    等价值 → 视为有据（补录命中原文为 quote）；推不出 → rejected，模型从
 *    Prompt 复制旧值的自证路径就此关闭（方案 §12 条目 3/15）。
 *
 * 模型仍保有解释权与纠错权：带真实 quote 的 normalized/correct/clear claim
 * 可以覆盖规则结果或历史值（方案 §1"不能通过完全禁止模型提交资料解决"）。
 */

export interface AdjudicateParams {
  claims: CandidateFactClaim[];
  /** 候选人消息文本集（剥引用块/时间后缀后的 user 原文）。quote 验证基准。 */
  candidateTexts: readonly string[];
  sessionAccepted: SessionAcceptedFacts;
  profileHints: ProfileHintFacts;
  messageWatermark: string;
  factsVersion: number;
  now?: Date;
}

export interface AdjudicationResult {
  profile: EffectiveCandidateProfile;
  adjudicated: AdjudicatedClaim[];
}

const PRODUCER_PRIORITY: Record<CandidateFactClaim['producer'], number> = {
  manual: 4,
  candidate_quote: 3,
  rule: 3,
  model: 2,
};

function quoteFoundInCandidateTexts(quote: string, texts: readonly string[]): boolean {
  return texts.some((text) => normalizedIncludes(text, quote));
}

/**
 * legacy 裸值 claim（无 quote）：尝试在候选人原文中找到可推导出等价值的片段。
 *
 * 与 direct-field producer 同一条不变式——**先截断再推导**，补录的 quote 必须
 * 原样支撑该值，否则紧接着的 `validateClaimValueAgainstQuote` 会拒掉自己刚补录的证据
 * （生产实测 2026-08-06：legacy 轨 1 例 `value_not_derivable` 即此形态）。
 */
function backfillQuoteFromCandidateTexts(
  claim: CandidateFactClaim,
  texts: readonly string[],
  now: Date,
): string | null {
  for (const text of texts) {
    const quote = text.slice(0, RULE_CLAIM_QUOTE_MAX_CHARS);
    const derived = deriveFieldValueFromQuote(claim.field, quote, now);
    if (derived !== null && candidateValuesEquivalent(claim.field, derived, claim.value)) {
      return quote;
    }
  }
  return null;
}

export function adjudicateCandidateClaims(params: AdjudicateParams): AdjudicationResult {
  const now = params.now ?? new Date();
  const adjudicated: AdjudicatedClaim[] = [];
  const validByField = new Map<CandidateClaimField, AdjudicatedClaim[]>();

  // —— 单条验证 ————————————————————————————————————————————
  for (const claim of params.claims) {
    let effectiveClaim = claim;

    if (!claim.evidence.quote.trim()) {
      // legacy 裸值：无 quote，先尝试从候选人全文补录证据。
      if (claim.operation === 'clear') {
        adjudicated.push({
          claim,
          decision: 'rejected',
          rejectionReason: 'quote_not_found',
        });
        continue;
      }
      const backfilled = backfillQuoteFromCandidateTexts(claim, params.candidateTexts, now);
      if (!backfilled) {
        adjudicated.push({
          claim,
          decision: 'rejected',
          rejectionReason: 'no_candidate_evidence',
        });
        continue;
      }
      effectiveClaim = {
        ...claim,
        interpretation: 'normalized',
        evidence: { ...claim.evidence, quote: backfilled },
      };
    } else if (!quoteFoundInCandidateTexts(claim.evidence.quote, params.candidateTexts)) {
      adjudicated.push({ claim, decision: 'rejected', rejectionReason: 'quote_not_found' });
      continue;
    }

    const failure = validateClaimValueAgainstQuote(effectiveClaim, now);
    if (failure) {
      adjudicated.push({
        claim: effectiveClaim,
        decision: 'rejected',
        rejectionReason: failure.reason,
      });
      continue;
    }

    const entry: AdjudicatedClaim = { claim: effectiveClaim, decision: 'accepted' };
    adjudicated.push(entry);
    const list = validByField.get(effectiveClaim.field) ?? [];
    list.push(entry);
    validByField.set(effectiveClaim.field, list);
  }

  // —— 同字段归并 ————————————————————————————————————————————
  for (const entries of validByField.values()) {
    if (entries.length <= 1) continue;

    // correct/clear 是显式覆盖操作：最新一条生效，其前的全部 superseded。
    const lastOverride = [...entries]
      .reverse()
      .find((entry) => entry.claim.operation === 'correct' || entry.claim.operation === 'clear');
    if (lastOverride) {
      for (const entry of entries) {
        if (entry === lastOverride) continue;
        if (entry.claim.assertedAt <= lastOverride.claim.assertedAt) {
          entry.decision = 'superseded';
          entry.supersededByClaimId = lastOverride.claim.claimId;
        }
      }
    }

    const active = entries.filter((entry) => entry.decision === 'accepted');
    if (active.length <= 1) continue;

    const values = active.filter((entry) => entry.claim.operation !== 'clear');
    const allEquivalent = values.every((entry) =>
      candidateValuesEquivalent(entry.claim.field, entry.claim.value, values[0].claim.value),
    );

    if (allEquivalent) {
      // 同值多来源：高优先级 producer 的最新一条胜出，其余 superseded。
      const winner = [...values].sort(
        (a, b) =>
          PRODUCER_PRIORITY[b.claim.producer] - PRODUCER_PRIORITY[a.claim.producer] ||
          b.claim.assertedAt.localeCompare(a.claim.assertedAt),
      )[0];
      for (const entry of active) {
        if (entry === winner) continue;
        entry.decision = 'superseded';
        entry.supersededByClaimId = winner.claim.claimId;
      }
      continue;
    }

    // 有效证据值冲突：整字段拒绝并标 conflicted，交回模型/候选人重新确认，
    // 不做"规则一定赢模型"的静默二选一（方案 §5.1）。
    for (const entry of active) {
      entry.decision = 'rejected';
      entry.rejectionReason = 'conflicting_evidence';
    }
  }

  // 裸值与有据 claim 同值 → superseded 而非"无据"。
  // legacy 裸值自己没带 quote，靠全文推导补录；当另一条**带真实证据**的 claim 已就同一
  // 字段采信了等价值时，这个值其实是有据的，只是证据不在它自己身上——判 rejected 会污染
  // "模型无据率"这个 enforce 核心指标（badcase 6a7446eb：姓名经索名问答确证后，同值裸值
  // 仍被记一条 no_candidate_evidence）。superseded 才是诚实结论。
  for (const entry of adjudicated) {
    if (entry.decision !== 'rejected' || entry.rejectionReason !== 'no_candidate_evidence')
      continue;
    const winner = validByField
      .get(entry.claim.field)
      ?.find(
        (accepted) =>
          accepted.decision === 'accepted' &&
          candidateValuesEquivalent(entry.claim.field, accepted.claim.value, entry.claim.value),
      );
    if (!winner) continue;
    entry.decision = 'superseded';
    entry.rejectionReason = undefined;
    entry.supersededByClaimId = winner.claim.claimId;
  }

  const profile = buildEffectiveProfile({
    adjudicated,
    sessionAccepted: params.sessionAccepted,
    profileHints: params.profileHints,
    messageWatermark: params.messageWatermark,
    factsVersion: params.factsVersion,
    now,
  });

  return { profile, adjudicated };
}
