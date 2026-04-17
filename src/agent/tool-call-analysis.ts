/**
 * 工具调用结果分析工具
 *
 * 同时被 runner.service（generateText 路径）和 ai-stream-trace（streamText 路径）使用，
 * 保证 tool_calls jsonb 的 resultCount / status 语义一致。
 */

import type { AgentToolCallStatus } from '@shared-types/agent-telemetry.types';

/**
 * 单轮内同名工具调用上限。
 *
 * 排障来源：生产 batch_69e19d3e9d6d3a463b9523e8_1776396951802 中，模型对一个不稳定的
 * storeNameList 精确匹配查询失败后，连续调用 4 次 duliday_job_list 自行扩面，
 * 最终回复耗时 116s、消耗 36.9k tokens。Agent 层加硬上限避免类似失控循环。
 */
export const MAX_SAME_TOOL_CALLS_PER_TURN = 3;

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

/** prepareStep 入参中 step 的最小子集；这里只关心 toolCalls 的 toolName。 */
interface StepLike {
  toolCalls?: Array<{ toolName: string }>;
}

/** 统计已执行 steps 中各工具的累计调用次数。 */
export function countToolCallsByName(steps: StepLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const calls = step.toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const name = call.toolName;
      if (typeof name !== 'string' || name.length === 0) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 找出本轮已达调用上限的工具名列表。
 *
 * 用于在 prepareStep 中动态屏蔽，让 LLM 在第 4 次想调同一工具时被强制收敛。
 */
export function findToolsExceedingLimit(
  steps: StepLike[],
  limit: number = MAX_SAME_TOOL_CALLS_PER_TURN,
): string[] {
  const counts = countToolCallsByName(steps);
  const exceeded: string[] = [];
  for (const [name, count] of counts.entries()) {
    if (count >= limit) exceeded.push(name);
  }
  return exceeded;
}

/**
 * 构造一段拼到 system prompt 末尾的拦截提示。
 *
 * 给 LLM 一个明确的"为什么工具消失了"的解释，避免它误以为工具列表本来就不包含被屏蔽工具。
 */
export function buildToolCallLimitNotice(
  blockedTools: string[],
  limit: number = MAX_SAME_TOOL_CALLS_PER_TURN,
): string {
  if (blockedTools.length === 0) return '';
  const lines = blockedTools.map(
    (name) =>
      `⚠️ 系统拦截：工具 \`${name}\` 在本轮已达调用上限（${limit} 次），不可再继续调用。请基于已有工具结果直接收敛回复；如确实未能拿到可用数据，应如实告知候选人"暂时没找到符合条件的岗位"，不要再换 filter 硬试。`,
  );
  return lines.join('\n');
}
