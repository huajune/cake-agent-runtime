/**
 * Eight existing retry layers. Attempts include the first call; retries exclude it.
 * These are ceilings, not an instruction to retry. Unknown external outcomes always
 * go to action recovery; no layer may turn a timeout into permission to resend.
 */
export const RUNTIME_RETRY_LIMITS = Object.freeze({
  crashJobAttempts: 3,
  crashStalledRecoveries: 2,
  pendingInputReplays: 3,
  imageCompatibilityRetries: 1,
  outputRepairRetries: 1,
  textualToolRetries: 1,
  emptyZeroToolRetries: 1,
  modelAttempts: 3,
  sameToolCalls: 3,
  precheckCalls: 2,
  deliverySegmentRetries: 1,
});

/** A caller may narrow the model cap, but cannot multiply the existing ceiling. */
export function boundedModelAttempts(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? RUNTIME_RETRY_LIMITS.modelAttempts
    : Math.min(RUNTIME_RETRY_LIMITS.modelAttempts, Math.max(1, Math.floor(value)));
}
