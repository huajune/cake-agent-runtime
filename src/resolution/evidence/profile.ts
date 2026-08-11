import type { AdjudicatedClaim, CandidateClaimField, CandidateFactProducer } from './claim.types';
import { candidateValuesEquivalent } from './normalize';

/**
 * EffectiveCandidateProfile（方案 §4.2）：裁决结果的物化视图。
 *
 * 不是不可挑战的真理——模型发现视图有误时，可基于新的候选人证据提交
 * correct / clear claim 触发重新裁决。precheck 响应、PrecheckSnapshot、
 * Prompt 展示消费同一份视图，消除"每个消费者自带一套证据规则"的读侧分裂。
 */

export type CandidateFactStatus = 'accepted' | 'historical_unconfirmed' | 'conflicted' | 'missing';

export interface EffectiveCandidateField {
  /** 裁决后的当前有效值；missing / historical_unconfirmed（未确认）时为 null 或历史值。 */
  value: string | number | boolean | null;
  status: CandidateFactStatus;
  /** accepted 时的采信 claim。 */
  acceptedClaimId?: string;
  /** 被本次裁决取代的 claimId 列表。 */
  supersededClaimIds?: string[];
  source?: CandidateFactProducer | 'session' | 'profile';
  /** 采信证据摘录（截断），审计与 Prompt 披露用。 */
  evidenceQuote?: string;
  updatedAt?: string;
}

export interface EffectiveCandidateProfile {
  /** 裁决版本：同一会话内单调递增（用消息水位哈希派生）。 */
  factsVersion: number;
  /** 裁决时的候选人消息水位（条数+末条指纹），booking 校验新鲜度用。 */
  messageWatermark: string;
  fields: Partial<Record<CandidateClaimField, EffectiveCandidateField>>;
}

/** 会话层既有已接受值（来自高置信 sessionFacts），作为无新 claim 字段的基线。 */
export type SessionAcceptedFacts = Partial<
  Record<CandidateClaimField, { value: string | number | boolean; evidence?: string }>
>;

/** 长期画像线索：只能成为 historical_unconfirmed，绝不直接 accepted（方案 §3.1-4）。 */
export type ProfileHintFacts = Partial<Record<CandidateClaimField, string | number | boolean>>;

export interface BuildEffectiveProfileParams {
  adjudicated: AdjudicatedClaim[];
  sessionAccepted: SessionAcceptedFacts;
  profileHints: ProfileHintFacts;
  messageWatermark: string;
  factsVersion: number;
  now?: Date;
}

/**
 * 组装裁决视图。优先级（方案 §5.1，按证据新旧与明确程度）：
 * 本轮 accepted claim > 会话既有已接受值 > 长期画像（仅待确认）。
 * clear claim 使字段回到 missing 且屏蔽历史线索（否定过的值不得复活）。
 */
export function buildEffectiveProfile(
  params: BuildEffectiveProfileParams,
): EffectiveCandidateProfile {
  const now = (params.now ?? new Date()).toISOString();
  const fields: EffectiveCandidateProfile['fields'] = {};

  const acceptedByField = new Map<CandidateClaimField, AdjudicatedClaim>();
  const supersededByField = new Map<CandidateClaimField, string[]>();
  const clearedFields = new Set<CandidateClaimField>();
  const conflictedFields = new Set<CandidateClaimField>();

  for (const entry of params.adjudicated) {
    const field = entry.claim.field;
    if (entry.decision === 'superseded') {
      const list = supersededByField.get(field) ?? [];
      list.push(entry.claim.claimId);
      supersededByField.set(field, list);
      continue;
    }
    if (entry.decision !== 'accepted') {
      if (entry.rejectionReason === 'conflicting_evidence') conflictedFields.add(field);
      continue;
    }
    if (entry.claim.operation === 'clear') {
      clearedFields.add(field);
      acceptedByField.delete(field);
      continue;
    }
    acceptedByField.set(field, entry);
    clearedFields.delete(field);
  }

  for (const [field, entry] of acceptedByField) {
    fields[field] = {
      value: entry.claim.value as string | number | boolean | null,
      status: 'accepted',
      acceptedClaimId: entry.claim.claimId,
      supersededClaimIds: supersededByField.get(field),
      source: entry.claim.producer,
      evidenceQuote: entry.claim.evidence.quote.slice(0, 80),
      updatedAt: now,
    };
  }

  for (const field of clearedFields) {
    fields[field] = { value: null, status: 'missing', updatedAt: now };
  }

  for (const [field, fact] of Object.entries(params.sessionAccepted) as Array<
    [CandidateClaimField, { value: string | number | boolean; evidence?: string }]
  >) {
    if (fields[field]) continue;
    fields[field] = {
      value: fact.value,
      status: 'accepted',
      source: 'session',
      evidenceQuote: fact.evidence?.slice(0, 80),
      updatedAt: now,
    };
  }

  for (const [field, value] of Object.entries(params.profileHints) as Array<
    [CandidateClaimField, string | number | boolean]
  >) {
    if (fields[field]) continue;
    fields[field] = { value, status: 'historical_unconfirmed', source: 'profile', updatedAt: now };
  }

  for (const field of conflictedFields) {
    // 冲突覆盖 accepted 之外的其余来源：有未解决冲突的字段不得静默采信。
    if (fields[field]?.status !== 'accepted') {
      fields[field] = { value: fields[field]?.value ?? null, status: 'conflicted', updatedAt: now };
    }
  }

  return {
    factsVersion: params.factsVersion,
    messageWatermark: params.messageWatermark,
    fields,
  };
}

/** 视图中状态为 accepted 的字段值映射（快照/booking 对账用）。 */
export function pickAcceptedValues(
  profile: EffectiveCandidateProfile,
): Partial<Record<CandidateClaimField, string | number | boolean>> {
  const values: Partial<Record<CandidateClaimField, string | number | boolean>> = {};
  for (const [field, entry] of Object.entries(profile.fields) as Array<
    [CandidateClaimField, EffectiveCandidateField]
  >) {
    if (entry.status === 'accepted' && entry.value !== null) values[field] = entry.value;
  }
  return values;
}

/** 历史画像读侧的统一失效判定：当前会话有非等价值时，archive 只可标为 superseded。 */
export function isArchivedProfileFactSuperseded(
  field: CandidateClaimField,
  archivedValue: unknown,
  currentSessionValue: unknown,
): boolean {
  if (
    currentSessionValue === null ||
    currentSessionValue === undefined ||
    currentSessionValue === ''
  ) {
    return false;
  }
  return !candidateValuesEquivalent(field, archivedValue, currentSessionValue);
}
