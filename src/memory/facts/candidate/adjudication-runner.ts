import { stripMessageDecorations } from '@tools/shared/identity-statement.util';
import { extractMessageText } from '@tools/duliday/precheck/collection-strategy.util';
import { isResumeImageMessage, isVisualSourcePart } from '../visual-description';
import type {
  AdjudicatedClaim,
  CandidateClaimField,
  CandidateClaimInput,
  CandidateFactClaim,
} from './candidate-fact-claim.types';
import { adjudicateCandidateClaims } from './candidate-fact-adjudicator';
import {
  pickAcceptedValues,
  type EffectiveCandidateProfile,
  type ProfileHintFacts,
  type SessionAcceptedFacts,
} from './candidate-effective-profile';
import { produceDirectFieldClaims } from './producers/direct-field-claim.producer';
import { produceIdentityClaim } from './producers/identity-claim.producer';
import {
  produceLegacyModelClaims,
  produceModelClaims,
  type LegacyCandidateArgs,
} from './producers/model-claim.producer';
import { computeCandidateMessageWatermark, deriveFactsVersion } from './precheck-snapshot.types';

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
export function extractCandidateTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;

    const parts = Array.isArray(record.content) ? record.content : [record.content];
    const selfReportedParts = parts
      .map((part) => extractMessageText(part))
      .filter((text) => text && (!isVisualSourcePart(text) || isResumeImageMessage(text)));
    const raw = selfReportedParts.join(' ').trim();
    if (!raw) continue;
    const cleaned = stripMessageDecorations(raw);
    if (cleaned) texts.push(cleaned);
  }
  return texts;
}

export function runCandidateFactAdjudication(params: RunAdjudicationParams): AdjudicationRunResult {
  const now = params.now ?? new Date();
  const assertedAt = now.toISOString();
  const candidateTexts = extractCandidateTexts(params.messages);
  const messageWatermark = computeCandidateMessageWatermark(candidateTexts);
  const factsVersion = deriveFactsVersion(messageWatermark);

  const claims: CandidateFactClaim[] = [
    ...produceDirectFieldClaims({ candidateTexts, assertedAt, now }),
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
