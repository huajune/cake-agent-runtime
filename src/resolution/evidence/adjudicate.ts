import { resolveNameAnsweredToRealNameAsk } from './producers/name-confirmation';
import { extractCandidateTexts } from '@resolution/signal/self-report';
import type {
  AdjudicatedClaim,
  CandidateClaimField,
  CandidateClaimInput,
  CandidateFactClaim,
} from './claim.types';
import { adjudicateCandidateClaims } from './engine';
import {
  pickAcceptedValues,
  type EffectiveCandidateProfile,
  type ProfileHintFacts,
  type SessionAcceptedFacts,
} from './profile';
import { produceDirectFieldClaims } from './producers/direct-field';
import { produceIdentityClaim } from './producers/student-identity';
import {
  produceLegacyModelClaims,
  produceModelClaims,
  type LegacyCandidateArgs,
} from './producers/model-claims';
import { computeCandidateMessageWatermark, deriveFactsVersion } from './snapshot';

/**
 * 裁决编排门面：precheck 一次调用即得完整裁决结果。
 *
 * 组装顺序（方案 §6.2）：
 *   模型 claims（显式 candidateClaims + 旧裸字段 legacy 转译）
 *   + 当前会话消息规则 claims（direct producer 逐条锚定）
 *   + 身份唯一识别器 claim（identity producer）
 *   + 本会话 accepted 基线（高置信 sessionFacts）
 *   + 历史 Profile 待确认线索
 *   → adjudicateCandidateClaims → EffectiveCandidateProfile
 *
 * 本模块保持纯函数（无 IO/DI）；快照持久化由 CandidateSnapshotService 承担。
 */

export interface RunAdjudicationParams {
  /** 完整会话消息（原始形态；身份识别器与文本提取自带清洗）。 */
  messages: unknown[];
  /** 模型显式提交的 claim（precheck candidateClaims 入参）。 */
  modelClaimInputs?: readonly CandidateClaimInput[];
  /** 旧裸字段入参（candidateName 等归一化后的值），转译为 legacy model claim。 */
  legacyArgs?: LegacyCandidateArgs;
  sessionAccepted: SessionAcceptedFacts;
  profileHints: ProfileHintFacts;
  now?: Date;
}

export interface AdjudicationRunResult {
  profile: EffectiveCandidateProfile;
  adjudicated: AdjudicatedClaim[];
  acceptedValues: Partial<Record<CandidateClaimField, string | number | boolean>>;
  messageWatermark: string;
  factsVersion: number;
}

/**
 * 提取候选人侧**自陈**原文（user 角色，剥引用块/时间后缀/视觉描述），保持会话顺序。
 *
 * 视觉来源剔除（生产实测 2026-08-06，chat 6a714c00）：`save_image_description` 把
 * vision 描述回写进 user 消息，第三方截图里的招聘者手机号、岗位门槛年龄因此与候选人
 * 手打文本并列。本函数产出的文本集是 claim 的 **quote 验证基准**——不剔除等于把
 * "截图里出现过"当成"候选人说过"，第三方号码可在无冲突时直接 accepted 进快照
 * （与 [[project_badcase_image_identity_hijack]] / PR #870 同族，那次收窄的是抽取侧）。
 *
 * 逐 part 判定而非整条：多模态 content 数组扁平化后，描述前面还挂着
 * `[图片 messageId=…]` 占位标签，消息级 startsWith 判据会落空。
 * 候选人自己的简历图片是自陈材料，按既有裁定保留。
 */
export { extractCandidateTexts } from '@resolution/signal/self-report';

export function runCandidateFactAdjudication(params: RunAdjudicationParams): AdjudicationRunResult {
  const now = params.now ?? new Date();
  const assertedAt = now.toISOString();
  const candidateTexts = extractCandidateTexts(params.messages);
  const messageWatermark = computeCandidateMessageWatermark(candidateTexts);
  const factsVersion = deriveFactsVersion(messageWatermark);

  // 真名索取问答（badcase 6a7446eb）：Agent 问真名、候选人裸名直答。逐条文本的
  // parseName 只认"姓名：X"/"我叫X"结构化形态，裸名答推导不出——不补这条轨，模型
  // 传来的正确姓名会被判 no_candidate_evidence（生产实测 name 字段该拒因当日 40 条，
  // 本族占相当比例）。证据是跨轮问答对，故用完整 messages 而非 candidateTexts。
  const nameAnswer = resolveNameAnsweredToRealNameAsk(params.messages);

  const claims: CandidateFactClaim[] = [
    ...produceDirectFieldClaims({ candidateTexts, assertedAt, now }),
    ...(nameAnswer
      ? [
          {
            claimId: 'confirmation_name_1',
            field: 'name' as const,
            value: nameAnswer.name,
            operation: 'set' as const,
            producer: 'candidate_quote' as const,
            // 值本体在候选人应答里（不是问句里），故按 direct 校验——严格身份字段要求
            // 证据逐字含值，用问句作基准会被判自由推导。问句仅作审计上下文留存。
            interpretation: 'direct' as const,
            evidence: { quote: nameAnswer.quote, agentQuestionQuote: nameAnswer.askQuote },
            assertedAt,
          },
        ]
      : []),
    ...(params.legacyArgs ? produceLegacyModelClaims(params.legacyArgs, assertedAt) : []),
    ...(params.modelClaimInputs ? produceModelClaims(params.modelClaimInputs, assertedAt) : []),
  ];
  const identityClaim = produceIdentityClaim({ messages: params.messages, assertedAt });
  if (identityClaim) claims.push(identityClaim);

  const { profile, adjudicated } = adjudicateCandidateClaims({
    claims,
    candidateTexts,
    sessionAccepted: params.sessionAccepted,
    profileHints: params.profileHints,
    messageWatermark,
    factsVersion,
    now,
  });

  return {
    profile,
    adjudicated,
    acceptedValues: pickAcceptedValues(profile),
    messageWatermark,
    factsVersion,
  };
}
