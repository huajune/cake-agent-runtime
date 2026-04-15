/**
 * 基于基础延时生成人类化抖动，避免固定节奏过于机械。
 */
export function resolveHumanizedDelayMs(
  baseDelayMs: number,
  options?: {
    minFactor?: number;
    maxFactor?: number;
  },
): number {
  const normalizedBase =
    Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? Math.floor(baseDelayMs) : 0;
  if (normalizedBase <= 0) return 0;

  const minFactor = options?.minFactor ?? 1.5;
  const maxFactor = options?.maxFactor ?? 3;
  const lower = Math.min(minFactor, maxFactor);
  const upper = Math.max(minFactor, maxFactor);

  const minDelay = Math.max(0, Math.round(normalizedBase * lower));
  const maxDelay = Math.max(minDelay, Math.round(normalizedBase * upper));

  return minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));
}
