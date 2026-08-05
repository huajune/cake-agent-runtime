import type { CandidateClaimField } from './candidate-fact-claim.types';
import type { EffectiveCandidateProfile } from './candidate-effective-profile';

/**
 * PrecheckSnapshot（方案 §4.3）：precheck 成功后的不可变裁决快照。
 *
 * booking 用它验证模型最终提交值——防止 Prompt 中的旧资料在 precheck 之后
 * 重新进入 API payload（方案 §6.3）。快照按 precheckId 存 Redis，TTL 内有效；
 * 候选人新消息（水位变化）或 Replay（turnId 变化）都会让旧快照失效。
 */
export interface PrecheckSnapshot {
  /** `pc_{turnId}_{jobId}`：同批输入重跑（Bull 重试）得到相同 id，幂等覆盖。 */
  precheckId: string;
  factsVersion: number;
  /** 裁决时的候选人消息水位；booking 侧重算比对，变化即快照过期。 */
  messageWatermark: string;
  jobId: number;
  effectiveProfile: EffectiveCandidateProfile;
  acceptedClaimIds: string[];
  missingFields: CandidateClaimField[];
  createdAt: string;
  expiresAt: string;
}

/** 快照 TTL：与会话事实同量级；过期后 booking 必须重新 precheck。 */
export const PRECHECK_SNAPSHOT_TTL_SECONDS = 2 * 60 * 60;

/**
 * 候选人消息水位：条数 + 末条文本指纹（长度+首尾各 24 字）。
 * 消息管道无稳定 messageId，用内容指纹替代；同批重跑水位不变（可比对），
 * 新消息追加后水位必变（快照失效）。
 */
export function computeCandidateMessageWatermark(candidateTexts: readonly string[]): string {
  const count = candidateTexts.length;
  const last = candidateTexts[count - 1] ?? '';
  const head = last.slice(0, 24);
  const tail = last.length > 48 ? last.slice(-24) : '';
  return `${count}:${last.length}:${head}${tail}`;
}

/** factsVersion：水位字符串的确定性小哈希（同水位同版本，重跑稳定）。 */
export function deriveFactsVersion(messageWatermark: string): number {
  let hash = 0;
  for (let i = 0; i < messageWatermark.length; i += 1) {
    hash = (hash * 31 + messageWatermark.charCodeAt(i)) >>> 0;
  }
  return hash;
}
