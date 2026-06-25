/**
 * 工具调用结果分析工具
 *
 * 同时被 runner.service（generateText 路径）和 ai-stream-trace（streamText 路径）使用，
 * 保证 tool_calls jsonb 的 resultCount / status 语义一致。
 */

import type { AgentToolCallStatus } from '@shared-types/agent-telemetry.types';
import type { AgentToolCall } from './agent-run.types';

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

/**
 * 语义上属于"查询成功但零结果"的 errorType：虽走 buildToolError 通道，
 * 但应映射为 empty 而非 error——v5.13.2 上线后两小时 job_list.no_results
 * 占 job_list "错误"的 24/27，把业务空态和系统故障混在一起会让错误率失真，
 * 也让 tool_empty_result 异常旗标失去本职信号。
 */
const EMPTY_RESULT_ERROR_TYPES = new Set(['job_list.no_results', 'job_list.schedule_filter_empty']);

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
    if (typeof obj.errorType === 'string' && EMPTY_RESULT_ERROR_TYPES.has(obj.errorType)) {
      return 'empty';
    }
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

/**
 * 副作用工具：调用会改变外部系统状态（提交预约/拉群/取消/改约）。
 * 本轮已成功执行过一次后必须屏蔽，防止模型重复提交（线上观测到同 turn
 * booking 连续调用 2 次的样本）；失败后的重试不受此限制（自纠错合法）。
 */
export const SIDE_EFFECT_TOOLS = new Set([
  'duliday_interview_booking',
  'invite_to_group',
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
]);

/**
 * 判定单个工具返回值是否表示「副作用已成功提交」。
 *
 * ⚠️ 必须用**正向成功信号**判定，不能用 `'errorType' in result`：booking 成功结果
 * 显式带 `errorType: null`（见 duliday-interview-booking.tool），`'errorType' in r`
 * 对成功也为 true，会把成功预约误判成"无副作用"→ HC-1 revise 走全量重跑 → 重复 booking。
 *
 * 正向信号：success/accepted/dispatched===true，或带 workOrderId（booking 成功回执）。
 * 其余（含 buildToolError 的 `typeof errorType === 'string'`）一律非成功。
 */
export function isToolSuccess(result: unknown): boolean {
  const r = asRecord(result);
  if (!r) return false;
  if (typeof r.errorType === 'string') return false;
  if (r.success === false || r.accepted === false || r.dispatched === false) return false;
  if (r.success === true || r.accepted === true || r.dispatched === true) return true;
  if (r.workOrderId !== null && r.workOrderId !== undefined) return true;
  return false;
}

/**
 * HC-1：本轮（扁平化 toolCalls）是否已提交过任一副作用工具且成功。
 *
 * 与 `findSucceededSideEffectTools`（基于 steps，prepareStep 内屏蔽用）区别：本函数
 * 作用于 runner/turn 层的 `AgentToolCall[]`（含 `.result`），供 revise 分支判定
 * "是否只能无工具文本重写"。
 */
export function hasCommittedSideEffect(
  toolCalls: Array<{ toolName: string; result?: unknown }>,
): boolean {
  return toolCalls.some((tc) => SIDE_EFFECT_TOOLS.has(tc.toolName) && isToolSuccess(tc.result));
}

/**
 * 工具返回结果是否要求运行时短路。
 *
 * AI SDK 原始 toolResult 使用 `.output`，归一后的 AgentToolCall 使用 `.result`；
 * 两处都必须共享同一语义，避免 HANDOFF_NO_BOOKING(shortCircuited:false) 与
 * booking gate hard-reject(shortCircuited:true) 在不同链路被误判。
 */
export function isShortCircuitedToolResult(result: unknown): boolean {
  const r = asRecord(result);
  return r?.shortCircuited === true;
}

/** 归一后的 AgentToolCall 是否短路；skip_reply 是无条件沉默工具。 */
export function isShortCircuitedToolCall(
  call: Pick<AgentToolCall, 'toolName' | 'result'>,
): boolean {
  if (call.toolName === 'skip_reply') return true;
  return isShortCircuitedToolResult(call.result);
}

/** booking provenance gate hard-reject 会在 outcome 层转人工。 */
export function isBookingGateRejectedToolCall(
  call: Pick<AgentToolCall, 'toolName' | 'result'>,
): boolean {
  if (call.toolName !== 'duliday_interview_booking') return false;
  const r = asRecord(call.result);
  return r?.shortCircuited === true && r.gateRejected === true;
}

/** prepareStep 入参中 step 的最小子集；这里只关心 toolCalls 的 toolName。 */
interface StepLike {
  toolCalls?: Array<{ toolName: string }>;
  toolResults?: Array<{ toolName?: string; output?: unknown }>;
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
 * 找出本轮已**成功**执行过的副作用工具。
 *
 * 判定口径与 computeToolCallStatus 一致：仅明确成功（ok/narrow，工具的
 * success/accepted 标记为 true 都会映射到 ok）才视为副作用已生效。
 * 失败（buildToolError 形态）与不可判定（unknown/empty）均不屏蔽——
 * 允许模型修正参数后重试；真实工具的成功返回都带显式成功标记，
 * unknown 只会出现在结构不可识别的边缘形态，保守放行。
 */
export function findSucceededSideEffectTools(steps: StepLike[]): string[] {
  const succeeded = new Set<string>();
  for (const step of steps) {
    const results = step.toolResults;
    if (!Array.isArray(results)) continue;
    for (const tr of results) {
      const name = tr.toolName;
      if (typeof name !== 'string' || !SIDE_EFFECT_TOOLS.has(name)) continue;
      const status = computeToolCallStatus(tr.output, computeResultCount(tr.output));
      if (status === 'ok' || status === 'narrow') succeeded.add(name);
    }
  }
  return [...succeeded];
}

/**
 * 构造副作用工具的拦截提示（拼到 system prompt 末尾）。
 */
export function buildSideEffectBlockNotice(blockedTools: string[]): string {
  if (blockedTools.length === 0) return '';
  return blockedTools
    .map(
      (name) =>
        `⚠️ 系统拦截：工具 \`${name}\` 本轮已成功执行（副作用已生效），不可重复调用。请基于已有结果直接收敛回复；如需对其他岗位/群执行同类操作，等候选人下一轮消息再进行。`,
    )
    .join('\n');
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
