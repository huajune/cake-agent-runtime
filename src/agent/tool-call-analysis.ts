/**
 * 工具调用结果分析工具
 *
 * 同时被 runner.service（generateText 路径）和 ai-stream-trace（streamText 路径）使用，
 * 保证 tool_calls jsonb 的 resultCount / status 语义一致。
 */

import type { AgentToolCallStatus } from '@shared-types/agent-telemetry.types';

/**
 * 从工具返回值推断"结果条数"，判不出返回 undefined。
 *
 * 常见工具返回约定：
 * - 数组直接 length
 * - 对象里 items / data / results / list / jobs / records 任一数组字段
 * - 对象里 total / count 任一数字字段
 */
export function computeResultCount(result: unknown): number | undefined {
  if (result === undefined || result === null) return undefined;
  if (Array.isArray(result)) return result.length;
  if (typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  for (const key of ['items', 'data', 'results', 'list', 'jobs', 'records']) {
    const value = obj[key];
    if (Array.isArray(value)) return value.length;
  }
  for (const key of ['total', 'count']) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * 基于 resultCount + error/state 推断工具调用状态。
 *
 * - error: result 对象含 error 字段，或外部 errorText/state 指示失败
 * - empty: resultCount === 0
 * - narrow: resultCount === 1
 * - unknown: 返回成功但无法推断结果条数
 * - ok: 其他（结果条数 >= 2）
 */
export function computeToolCallStatus(
  result: unknown,
  resultCount: number | undefined,
  errorText?: string,
  state?: string,
): AgentToolCallStatus {
  if (errorText && errorText.trim().length > 0) return 'error';
  if (state && /error|fail/i.test(state)) return 'error';
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const errorField = (result as Record<string, unknown>).error;
    if (errorField !== null && errorField !== undefined && errorField !== false) return 'error';
  }
  if (resultCount === undefined) return 'unknown';
  if (resultCount === 0) return 'empty';
  if (resultCount === 1) return 'narrow';
  return 'ok';
}
