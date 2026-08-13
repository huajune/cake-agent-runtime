/** 等待指定毫秒。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待指定毫秒，且定时器不阻止进程退出（shutdown / 后台轮询用）。 */
export function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** 指数退避毫秒数：base * 2^(attempt-1)，上限 max。attempt 从 1 起。 */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
}
