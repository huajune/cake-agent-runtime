import type { AdjudicatedClaim, CandidateClaimField, CandidateFactProducer } from './claim.types';
import { candidateValuesEquivalent } from './normalize';

/**
 * EffectiveCandidateProfile（方案 §4.2）：裁决结果的物化视图。
 *
 * 不是不可挑战的真理——模型发现视图有误时，可基于新的候选人证据提交
 * correct / clear claim 触发重新裁决。precheck 响应、PrecheckSnapshot、
 * Prompt 展示消费同一份视图，消除"每个消费者自带一套证据规则"的读侧分裂。
 */

/**
 * 字段状态。`needs_confirmation` 取代旧的 `conflicted` 终局：出处存疑不再让字段出局，
 * 而是带值进收资清单做一句复述——系统内终审权在候选人本人（宪法 P11）。
 */
export type CandidateFactStatus =
  | 'accepted'
  | 'historical_unconfirmed'
  | 'needs_confirmation'
  | 'missing';

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
  /** 转确认字段 → 待候选人拍板的值（取最新一条，供 D1 渲染复述句）。 */
  const pendingConfirmation = new Map<CandidateClaimField, AdjudicatedClaim>();

  for (const entry of params.adjudicated) {
    const field = entry.claim.field;
    if (entry.decision === 'superseded') {
      const list = supersededByField.get(field) ?? [];
      list.push(entry.claim.claimId);
      supersededByField.set(field, list);
      continue;
    }
    if (entry.decision === 'needs_confirmation') {
      const previous = pendingConfirmation.get(field);
      if (!previous || previous.claim.assertedAt <= entry.claim.assertedAt) {
        pendingConfirmation.set(field, entry);
      }
      continue;
    }
    if (entry.decision !== 'accepted') continue;
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

  // 转确认在会话基线/画像**之前**落位：本轮出处存疑的字段不能因为会话里恰好躺着一个
  // 旧值就把疑问吞掉（那是静默覆盖）。值仍带进清单——扣着值等于让候选人从头重报。
  for (const [field, entry] of pendingConfirmation) {
    if (fields[field]) continue; // 本轮已有 accepted/cleared 结论时不再打扰
    fields[field] = {
      value: (entry.claim.value as string | number | boolean | null) ?? null,
      status: 'needs_confirmation',
      evidenceQuote: entry.claim.evidence.quote.slice(0, 80),
      source: entry.claim.producer,
      updatedAt: now,
    };
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

/**
 * 待候选人拍板的字段值映射。消费纪律同 CandidatePrefillHint 三禁令：只准渲染成
 * 「值（如有误请改）」随整表确认，不得据此拒绝、提交或升级来源。
 */
export function pickNeedsConfirmationValues(
  profile: EffectiveCandidateProfile,
): Partial<Record<CandidateClaimField, string | number | boolean>> {
  const values: Partial<Record<CandidateClaimField, string | number | boolean>> = {};
  for (const [field, entry] of Object.entries(profile.fields) as Array<
    [CandidateClaimField, EffectiveCandidateField]
  >) {
    if (entry.status === 'needs_confirmation' && entry.value !== null) values[field] = entry.value;
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
