/**
 * 带超时的 fetch 封装。
 *
 * Node 原生 fetch 没有整体超时（undici 仅有 headers 阶段的默认超时，响应体可以无限挂起）。
 * 下游 API（海绵/托管平台等）一旦卡顿，会直接拖住 Agent 的工具执行循环，候选人 30s+ 无回复，
 * 且排障时无法区分"模型慢"还是"工具慢"。所有出站 fetch 必须经过本封装。
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

export class FetchTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(`请求超时（${timeoutMs}ms）: ${url}`);
    this.name = 'FetchTimeoutError';
  }
}

export async function fetchWithTimeout(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...requestInit } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    return await fetch(url, { ...requestInit, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
