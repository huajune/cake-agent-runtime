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
 * "narrow（仅 1 条结果）"语义只对搜索类工具有意义：
 * 查岗只命中 1 个岗位值得标记复查；geocode unique / booking 成功等单结果是正常形态。
 */
const NARROW_SEMANTIC_TOOLS = new Set(['duliday_job_list']);

/**
 * buildToolError 的成功标记键（见 tools/types/tool-error-types.ts）：
 * 各工具用其中一个键表达成功/失败（success/accepted/dispatched/found）。
 */
const SUCCESS_FLAG_KEYS = ['success', 'accepted', 'dispatched', 'found'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 从工具返回值推断"结果条数"，判不出返回 undefined。
 *
 * 识别顺序（与各内置工具的真实返回形态对齐，曾因只认 items/total 等键
 * 导致线上 status 全量 unknown、empty/narrow 异常旗标永不触发）：
 * - 对象里显式的 `resultCount` 数字字段（工具自报，最可靠）
 * - geocode 形态：`resolution: 'unique'` → 1；`'ambiguous'` → candidates.length
 * - 数组直接 length
 * - 对象里 items / data / results / list / jobs / records / candidates 任一数组字段
 * - 对象里 total / count 任一数字字段
 */
export function computeResultCount(result: unknown): number | undefined {
  if (result === undefined || result === null) return undefined;
  if (Array.isArray(result)) return result.length;
  const obj = asRecord(result);
  if (!obj) return undefined;

  if (typeof obj.resultCount === 'number' && Number.isFinite(obj.resultCount)) {
    return obj.resultCount;
  }
  if (obj.resolution === 'unique') return 1;
  if (obj.resolution === 'ambiguous' && Array.isArray(obj.candidates)) {
    return obj.candidates.length;
  }
  for (const key of ['items', 'data', 'results', 'list', 'jobs', 'records', 'candidates']) {
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
 * 基于 resultCount + error/state + buildToolError 约定推断工具调用状态。
 *
 * - error: 外部 errorText/state 指示失败；result 含 errorType / error 字段；
 *          或 success/accepted/dispatched/found 任一标记为 false（buildToolError 约定）
 * - empty: resultCount === 0
 * - narrow: resultCount === 1 且工具属于搜索类（NARROW_SEMANTIC_TOOLS）
 * - ok: resultCount >= 1（非搜索类含单结果），或成功标记为 true
 * - unknown: 以上都判不出
 */
export function computeToolCallStatus(
  result: unknown,
  resultCount: number | undefined,
  errorText?: string,
  state?: string,
  toolName?: string,
): AgentToolCallStatus {
  if (errorText && errorText.trim().length > 0) return 'error';
  if (state && /error|fail/i.test(state)) return 'error';

  const obj = asRecord(result);
  if (obj) {
    if (typeof obj.errorType === 'string' && obj.errorType.length > 0) return 'error';
    const errorField = obj.error;
    if (errorField !== null && errorField !== undefined && errorField !== false) return 'error';
    for (const key of SUCCESS_FLAG_KEYS) {
      if (obj[key] === false) return 'error';
    }
  }

  if (resultCount === 0) return 'empty';
  if (resultCount !== undefined && resultCount >= 1) {
    if (resultCount === 1 && toolName !== undefined && NARROW_SEMANTIC_TOOLS.has(toolName)) {
      return 'narrow';
    }
    return 'ok';
  }

  if (obj) {
    for (const key of SUCCESS_FLAG_KEYS) {
      if (obj[key] === true) return 'ok';
    }
    // skip_reply 等本地工具的轻量成功形态
    if (obj.skipped === true) return 'ok';
  }
  return 'unknown';
}

/** prepareStep 入参中 step 的最小子集；这里只关心 toolCalls 的 toolName。 */
interface StepLike {
  toolCalls?: Array<{ toolName: string }>;
}

/** 本轮 prior steps 已调用过的所有工具名（去重）。 */
export function collectCalledToolNames(steps: StepLike[]): Set<string> {
  const names = new Set<string>();
  for (const step of steps) {
    const calls = step.toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (typeof call.toolName === 'string' && call.toolName.length > 0) {
        names.add(call.toolName);
      }
    }
  }
  return names;
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
