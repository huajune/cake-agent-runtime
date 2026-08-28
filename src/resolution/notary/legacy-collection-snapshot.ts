/** 与 collection-form 3 天 TTL 对齐的一次性 Redis 兼容窗。 */
export const LEGACY_COLLECTION_SNAPSHOT_COMPAT_UNTIL = Date.parse('2026-08-31T00:00:00+08:00');

interface LegacySlotValue {
  confidence?: unknown;
}

interface LegacyCollectionSnapshot {
  slots: Record<number, { state: string; value?: unknown }>;
}

/** 兼容老快照；新 collection 类型不再暴露或写入该字段。 */
export function hasLegacyMediumSlotEvidence(
  form: LegacyCollectionSnapshot,
  nowMs: number,
): boolean {
  if (nowMs >= LEGACY_COLLECTION_SNAPSHOT_COMPAT_UNTIL) return false;
  return Object.values(form.slots).some(
    (slot) =>
      slot.state === 'filled' &&
      slot.value !== undefined &&
      (slot.value as LegacySlotValue).confidence === 'medium',
  );
}
