import { resolveNameAnsweredToRealNameAsk } from './producers/name-confirmation';
import { extractCandidateTextsFromCorpus } from '@resolution/signal/self-report';
import type {
  AdjudicatedClaim,
  CandidateClaimField,
  CandidateClaimInput,
  CandidateFactClaim,
} from './claim.types';
import { adjudicateCandidateClaims } from './engine';
import {
  pickAcceptedValues,
  pickNeedsConfirmationValues,
  type EffectiveCandidateProfile,
  type ProfileHintFacts,
  type SessionAcceptedFacts,
} from './profile';
import { extractDialogueTurns } from '@resolution/signal/dialogue';
import { produceDirectFieldClaims } from './producers/direct-field';
import { produceIdentityClaim } from './producers/student-identity';
import {
  produceLegacyModelClaims,
  produceModelClaims,
  type LegacyCandidateArgs,
} from './producers/model-claims';
import { computeCandidateMessageWatermark, deriveFactsVersion } from './snapshot';
import type { CorpusBlock } from '@shared-types/corpus.types';
import { buildConversationCorpus, selectCorpusMessages } from '@resolution/signal/corpus';

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
  /**
   * 与 messages 对应的结构化语料域。生产链路必须提供；缺省仅用于旧测试/离线调用，
   * 由封闭 role 映射即时补标签。
   */
  corpusBlocks?: readonly CorpusBlock[];
  /** 模型显式提交的 claim（precheck candidateClaims 入参）。 */
  modelClaimInputs?: readonly CandidateClaimInput[];
  /** 旧裸字段入参（candidateName 等归一化后的值），转译为 legacy model claim。 */
  legacyArgs?: LegacyCandidateArgs;
  sessionAccepted: SessionAcceptedFacts;
  profileHints: ProfileHintFacts;
  /**
   * 回声检查（工序 C4）是否参与裁决。迁移三阶段 P0 只观测（false，默认）：
   * 命中计入 `echoDetections` 供误报率抽查；P1 切换后转 needs_confirmation。
   */
  echoRoutesToConfirmation?: boolean;
  now?: Date;
}

export interface AdjudicationRunResult {
  profile: EffectiveCandidateProfile;
  adjudicated: AdjudicatedClaim[];
  acceptedValues: Partial<Record<CandidateClaimField, string | number | boolean>>;
  /** 待候选人拍板的字段值（工序 D1 收资清单渲染）。 */
  needsConfirmationValues: Partial<Record<CandidateClaimField, string | number | boolean>>;
  /** 回声检查命中数（shadow 期误报率抽查，判据④）。 */
  echoDetections: number;
  messageWatermark: string;
  factsVersion: number;
}

/**
 * 我方已发消息/工具结果全集（回声检查基准）。先按封闭域标签取 evidence/tool_result，
 * teaching 即使为了 SDK 传输伪装成 user，也不会进入回声审计。
 */
function extractEchoSourceTexts(corpusBlocks: readonly CorpusBlock[]): string[] {
  const sourceMessages = selectCorpusMessages(corpusBlocks, {
    domains: ['evidence', 'tool_result'],
    roles: ['assistant', 'tool'],
  }).map((message) => ({ role: 'assistant', content: message.content }));
  return extractDialogueTurns(sourceMessages).map((turn) => turn.text);
}

export function runCandidateFactAdjudication(params: RunAdjudicationParams): AdjudicationRunResult {
  const now = params.now ?? new Date();
  const assertedAt = now.toISOString();
  const corpusBlocks = params.corpusBlocks ?? buildConversationCorpus(params.messages);
  const candidateTexts = extractCandidateTextsFromCorpus(corpusBlocks);
  const messageWatermark = computeCandidateMessageWatermark(candidateTexts);
  const factsVersion = deriveFactsVersion(messageWatermark);

  // 真名索取问答（badcase 6a7446eb）：Agent 问真名、候选人裸名直答。逐条文本的
  // parseName 只认"姓名：X"/"我叫X"结构化形态，裸名答匹配不上——不补这条轨，模型
  // 传来的正确姓名在闸门侧仍无出处。证据是跨轮问答对，故用完整 messages。
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
            // 值本体在候选人应答里（不是问句里），故按 direct 校验：严格身份字段要求
            // 引文逐字含值，用问句作基准会对不上。问句仅作审计上下文留存。
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

  const { profile, adjudicated, echoDetections } = adjudicateCandidateClaims({
    claims,
    candidateTexts,
    // 回声检查基准（工序 C4）：我方已发消息全集。岗位卡/收资模板都在这里面，
    // 模型把自己发出去的字当候选人自陈提交时，两边逐字同现即命中。
    assistantTexts: extractEchoSourceTexts(corpusBlocks),
    echoRoutesToConfirmation: params.echoRoutesToConfirmation,
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
    needsConfirmationValues: pickNeedsConfirmationValues(profile),
    echoDetections,
    messageWatermark,
    factsVersion,
  };
}
