import type { AdjudicatedClaim, CandidateClaimField, CandidateFactClaim } from './claim.types';
import { candidateValuesEquivalent } from './normalize';
import { notarizeCandidateClaim, type NotaryVerdict } from './notary';
import {
  buildEffectiveProfile,
  type EffectiveCandidateProfile,
  type ProfileHintFacts,
  type SessionAcceptedFacts,
} from './profile';

/**
 * 候选人事实裁决器（宪法 P11 分权令的执行本体）。纯函数、零 LLM、零 IO。
 *
 * 三步：公证（./notary 三问）→ 归并（同字段多 claim）→ 物化（EffectiveCandidateProfile）。
 *
 * 信任不按产者身份排序，也不用规则复算否决值。代码只回答
 * "这段引文站不站得住"，值对不对由候选人本人终审。
 */

export interface AdjudicateParams {
  claims: CandidateFactClaim[];
  /** 候选人可作证语料（剥引用块/时间后缀、剔非自有视觉描述的 user 原文）。 */
  candidateTexts: readonly string[];
  /** 我方已发消息全集（回声检查基准，工序 C4）。 */
  assistantTexts?: readonly string[];
  /** 回声命中是否参与裁决；shadow 期为 false（只观测），切换后为 true。 */
  echoRoutesToConfirmation?: boolean;
  sessionAccepted: SessionAcceptedFacts;
  profileHints: ProfileHintFacts;
  messageWatermark: string;
  factsVersion: number;
  now?: Date;
}

export interface AdjudicationResult {
  profile: EffectiveCandidateProfile;
  adjudicated: AdjudicatedClaim[];
  /** 回声检查的独立命中数（shadow 期误报率抽查用，判据④）。 */
  echoDetections: number;
}

/**
 * 同值多来源的胜出顺序。**不是信任等级**：同值时选谁只影响 evidenceQuote 展示与
 * acceptedClaimId 归属，不改变采信结果。绝不可退化为按产者排信任（P9 旧阶梯教义）。
 */
function evidenceGrade(entry: AdjudicatedClaim): number {
  if (entry.claim.operation === 'confirm') return 3; // 候选人本人确认过，终审级
  return entry.claim.evidence.quote.trim() ? 2 : 1;
}

function toDecision(verdict: NotaryVerdict, claim: CandidateFactClaim): AdjudicatedClaim {
  return {
    claim,
    decision: verdict.outcome === 'needs_confirmation' ? 'needs_confirmation' : 'rejected',
    rejectionReason: verdict.reason,
  };
}

export function adjudicateCandidateClaims(params: AdjudicateParams): AdjudicationResult {
  const now = params.now ?? new Date();
  const assistantTexts = params.assistantTexts ?? [];
  const adjudicated: AdjudicatedClaim[] = [];
  const validByField = new Map<CandidateClaimField, AdjudicatedClaim[]>();
  let echoDetections = 0;

  // —— 逐条公证 ————————————————————————————————————————————
  for (const claim of params.claims) {
    const { verdict, echo } = notarizeCandidateClaim({
      claim,
      candidateTexts: params.candidateTexts,
      assistantTexts,
      echoRoutesToConfirmation: params.echoRoutesToConfirmation,
    });
    if (echo.outcome !== 'pass') echoDetections += 1;

    if (verdict.outcome !== 'pass') {
      adjudicated.push(toDecision(verdict, claim));
      continue;
    }

    const entry: AdjudicatedClaim = { claim, decision: 'accepted' };
    adjudicated.push(entry);
    const list = validByField.get(claim.field) ?? [];
    list.push(entry);
    validByField.set(claim.field, list);
  }

  // —— 同字段归并 ————————————————————————————————————————————
  for (const entries of validByField.values()) {
    if (entries.length <= 1) continue;

    // correct/clear 是显式覆盖操作：最新一条生效，其前的全部 superseded。
    //
    // ⚠️ "其前"不能只看 assertedAt：同一次裁决里所有 claim 共享一个时间戳
    // （调用方统一用同一个 now.toISOString() 传给全部 producer），
    // 时间戳比较会恒成立，把覆盖操作**之后**提交的 claim 也一并杀掉——
    // 模型在同一轮先 clear 再 set 改正手机号时，改正值被静默丢弃、字段回 missing，
    // 候选人会被重新盘问已经给过的信息。同戳时以提交顺序（数组下标）判先后。
    const lastOverrideIndex = entries.reduce(
      (found, entry, index) =>
        entry.claim.operation === 'correct' || entry.claim.operation === 'clear' ? index : found,
      -1,
    );
    if (lastOverrideIndex >= 0) {
      const lastOverride = entries[lastOverrideIndex];
      for (const [index, entry] of entries.entries()) {
        if (index === lastOverrideIndex) continue;
        const precedesOverride =
          entry.claim.assertedAt < lastOverride.claim.assertedAt ||
          (entry.claim.assertedAt === lastOverride.claim.assertedAt && index < lastOverrideIndex);
        if (!precedesOverride) continue;
        entry.decision = 'superseded';
        entry.supersededByClaimId = lastOverride.claim.claimId;
      }
    }

    const active = entries.filter((entry) => entry.decision === 'accepted');
    if (active.length <= 1) continue;

    const values = active.filter((entry) => entry.claim.operation !== 'clear');
    const allEquivalent = values.every((entry) =>
      candidateValuesEquivalent(entry.claim.field, entry.claim.value, values[0].claim.value),
    );

    if (allEquivalent) {
      const winner = [...values].sort(
        (a, b) =>
          evidenceGrade(b) - evidenceGrade(a) ||
          b.claim.assertedAt.localeCompare(a.claim.assertedAt),
      )[0];
      for (const entry of active) {
        if (entry === winner) continue;
        entry.decision = 'superseded';
        entry.supersededByClaimId = winner.claim.claimId;
      }
      continue;
    }

    // 冲突不再判 rejected（旧行为连坐互杀：两条都出局、字段回 missing、候选人被
    // 重新盘问，而其中一条通常是对的）。改为整字段转本人终审。
    for (const entry of active) {
      entry.decision = 'needs_confirmation';
      entry.rejectionReason = 'conflicting_evidence';
    }
  }

  // 裸值与有据 claim 同值 → superseded 而非"无据"：值其实有据，只是证据不在它自己
  // 身上。判 rejected 会污染"作证通道占比"判据（badcase 6a7446eb）。
  for (const entry of adjudicated) {
    if (entry.decision !== 'rejected' || entry.rejectionReason !== 'quote_not_found') continue;
    if (entry.claim.evidence.quote.trim()) continue; // 只赦免裸值，不赦免编造引文
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

  return { profile, adjudicated, echoDetections };
}
