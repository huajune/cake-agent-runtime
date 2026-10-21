/**
 * 工具调用结果分析工具
 *
 * 同时被 generator.agent（generateText 路径）和 ai-stream-trace（streamText 路径）使用，
 * 保证 tool_calls jsonb 的 resultCount / status 语义一致。
 */

import { actionReceiptStatuses, actionReplayStatus } from '@infra/utils/action-receipt.util';
import type { ToolReplayEvidence, ToolReplayStatus } from '@shared-types/tool-replay.types';
import type { AgentToolCallStatus } from '@shared-types/agent-telemetry.types';
import { TOOL_ERROR_TYPES, type ToolErrorType } from '@tools/shared/tool-error-types';
import { asRecord } from '@infra/utils/object.util';
import {
  BUILT_IN_TOOL_CONTRACTS,
  DEFAULT_TOOL_CALL_LIMIT,
  getBuiltInToolContract,
  toolNamesMatching,
} from '@tools/tool-contracts';
import type { AgentToolCall } from './generator.types';

/**
 * 单轮内同名工具调用上限。
 *
 * 模型在不稳定入参（如 storeNameList 精确匹配）查询失败后会连续多次调同一工具自行扩面，
 * 把单轮拖到百秒级、token 翻数倍。Agent 层加硬上限阻断这类失控循环。
 */
export const MAX_SAME_TOOL_CALLS_PER_TURN = DEFAULT_TOOL_CALL_LIMIT;

/**
 * precheck 是同一岗位的确定性校验，不应靠换参数穷举；保留一次纠正遗漏入参的机会，
 * 第二次后即屏蔽，避免身份/补充字段识别异常时单轮连续调用 4~5 次。
 */
export const MAX_PRECHECK_CALLS_PER_TURN =
  BUILT_IN_TOOL_CONTRACTS.duliday_interview_precheck.maxCallsPerTurn;

/**
 * "narrow（仅 1 条结果）"语义只对搜索类工具有意义：
 * 查岗只命中 1 个岗位值得标记复查；geocode unique / booking 成功等单结果是正常形态。
 */
const NARROW_SEMANTIC_TOOLS = new Set(['duliday_job_list']);

/**
 * buildToolError 的成功标记键（见 tools/shared/tool-error-types.ts）：
 * 各工具用其中一个键表达成功/失败（success/accepted/dispatched/found）。
 */
const SUCCESS_FLAG_KEYS = ['success', 'accepted', 'dispatched', 'found'] as const;

/**
 * 语义上属于"查询成功但零结果"的 errorType：虽走 buildToolError 通道，
 * 但应映射为 empty 而非 error——v5.13.2 上线后两小时 job_list.no_results
 * 占 job_list "错误"的 24/27，把业务空态和系统故障混在一起会让错误率失真，
 * 也让 tool_empty_result 异常旗标失去本职信号。
 * query_incomplete 表示已查范围内暂无可推荐岗位（扫描未完整或班次待确认），同属业务空态。
 */
const EMPTY_RESULT_ERROR_TYPES = new Set<string>([
  TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
  TOOL_ERROR_TYPES.JOB_LIST_SCHEDULE_FILTER_EMPTY,
  TOOL_ERROR_TYPES.JOB_LIST_QUERY_INCOMPLETE,
]);

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
  const statuses = actionReceiptStatuses(result);
  if (statuses.some((status) => status !== 'failed' && status !== 'succeeded')) return 'unknown';
  if (statuses.includes('succeeded')) return 'ok';
  if (statuses.includes('failed')) return 'error';
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
 * 从工具返回值提取 errorType（buildToolError 约定的机器可读错误分类）。
 *
 * 成功态 errorType 为 null → 返回 undefined，仅失败态携带非空 errorType。
 * 落进 tool_call 观测事件 payload，供按失败子类低成本统计（如改约/取消工具的
 * `*_request_failed` 瞬时抖动 vs `*_rejected` 业务拒绝），无需回刨
 * message_processing_records 的大 jsonb（该列无索引、逐行解压会拖慢生产）。
 */
export function extractToolErrorType(result: unknown): ToolErrorType | undefined {
  const obj = asRecord(result);
  if (!obj) return undefined;
  // errorType 恒由 buildToolError 产出，值域即 TOOL_ERROR_TYPES；从 unknown 结果读出后按该契约
  // 收窄为 ToolErrorType——单一权威定义在 tool-error-types.ts，此处复用、不另立字符串类型。
  return typeof obj.errorType === 'string' && obj.errorType.length > 0
    ? (obj.errorType as ToolErrorType)
    : undefined;
}

/**
 * 提取工具透传的下游接口返回码（buildToolError 的 `details.apiCode`，被展开到返回值顶层；
 * 如海绵 cancel/modify 的业务 code）。
 *
 * 仅业务拒绝态携带（`*_rejected`）；瞬时抛错自纠（`*_request_failed`，details 只有 reason）
 * 与成功态均无此字段。与 errorType 一起落观测事件，用于区分"接口业务拒绝（有 apiCode）"
 * 与"接口抖动/超时（无 apiCode）"——后者才是加重试可能捞回的类别。
 */
export function extractToolApiCode(result: unknown): string | number | undefined {
  const obj = asRecord(result);
  if (!obj) return undefined;
  const code = obj.apiCode;
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.length > 0) return code;
  return undefined;
}

/**
 * 副作用工具：调用会改变外部系统状态（提交预约/拉群/取消/改约）。
 * 本轮已成功执行过一次后必须屏蔽，防止模型重复提交（线上观测到同 turn
 * booking 连续调用 2 次的样本）；失败后的重试不受此限制（自纠错合法）。
 */
export const SIDE_EFFECT_TOOLS = toolNamesMatching(
  (value) => value.effect === 'external_action' || value.effect === 'intervention_intent',
);

export const REPLAY_BLOCKING_TOOLS = toolNamesMatching(
  (value) => value.replay === 'block_on_success',
);

export { TOOL_GUARDRAIL_IDS } from '@agent/guardrail/tool/tool-guardrail.catalog';

export function isSideEffectTool(toolName: string): boolean {
  return SIDE_EFFECT_TOOLS.has(toolName);
}

/**
 * 判定单个工具返回值是否表示「副作用已成功提交」。
 *
 * ⚠️ 必须用**正向成功信号**判定，不能用 `'errorType' in result`：booking 成功结果
 * 显式带 `errorType: null`（见 duliday-interview-booking.tool），`'errorType' in r`
 * 对成功也为 true，会把成功预约误判成"无副作用"→ prepareStep 不屏蔽副作用工具、
 * replay 不跳过 → 重复 booking。
 *
 * actionStatus（含 groupInvite）优先：只有明确 succeeded 才算已发生成功动作；
 * 没有机器状态的旧回执才回退到 success/accepted/dispatched/workOrderId 正向证据。
 */
export function isToolSuccess(result: unknown): boolean {
  const r = asRecord(result);
  if (!r) return false;
  const statuses = actionReceiptStatuses(r);
  if (statuses.length > 0) return statuses.includes('succeeded');
  if (typeof r.errorType === 'string') return false;
  if (r.success === false || r.accepted === false || r.dispatched === false) return false;
  if (r.sideEffectCommitted === true) return true;
  if (r.success === true || r.accepted === true || r.dispatched === true) return true;
  if (typeof r.workOrderId === 'number' && r.workOrderId > 0) return true;
  if (typeof r.workOrderId === 'string' && r.workOrderId.trim().length > 0) return true;
  return false;
}

/** 单个工具结果是否明确表示副作用已提交。 */
export function isSideEffectCommitted(result: unknown): boolean {
  return isToolSuccess(result);
}

/** A fence is distinct from success: uncertain or unauthorized actions cannot be blindly replayed. */
export function replayBlockingStatus(result: unknown): ToolReplayStatus | undefined {
  const status = actionReplayStatus(result);
  if (status) return status;
  if (actionReceiptStatuses(result).length > 0) return undefined; // definite failure
  if (isToolSuccess(result)) return 'succeeded';
  const record = asRecord(result);
  // Existing validation/business rejections may still be corrected within the old call cap.
  if (
    record &&
    (typeof record.errorType === 'string' ||
      record.success === false ||
      record.accepted === false ||
      record.dispatched === false)
  )
    return undefined;
  return 'unknown';
}

export function collectToolReplayEvidence(
  calls: Array<{ toolName: string; toolCallId?: string; result?: unknown }>,
): ToolReplayEvidence[] {
  return calls.flatMap((call) => {
    if (!isSideEffectTool(call.toolName)) return [];
    const status = replayBlockingStatus(call.result);
    return status ? [{ toolName: call.toolName, toolCallId: call.toolCallId, status }] : [];
  });
}

/**
 * HC-1：本轮（扁平化 toolCalls）是否已提交过任一副作用工具且成功。
 *
 * 与 `findReplayBlockedSideEffectTools`（基于 steps，含未知/阻断，prepareStep 内屏蔽用）区别：本函数
 * 作用于 runner/turn 层的 `AgentToolCall[]`（含 `.result`），供出站守卫
 * resolveHighRiskTrigger 判定本轮是否已有既成副作用（决定高风险强制审查档）。
 */
export function hasCommittedSideEffect(
  toolCalls: Array<{ toolName: string; result?: unknown }>,
): boolean {
  return toolCalls.some((tc) => isSideEffectTool(tc.toolName) && isSideEffectCommitted(tc.result));
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

const SKIP_REPLY_TOOL_NAME = 'skip_reply';

/**
 * skip_reply 是否被接受：工具返回 `skipped === true`。被拒绝的调用（scene=human_takeover
 * 但真人并未在沟通）返回 buildToolError 形态（skipped=false、errorType），不算沉默。
 */
export function isAcceptedSkipReplyResult(result: unknown): boolean {
  return asRecord(result)?.skipped === true;
}

/** 归一后的 AgentToolCall 是否短路；skip_reply 只有被接受（skipped=true）才算沉默短路。 */
export function isShortCircuitedToolCall(
  call: Pick<AgentToolCall, 'toolName' | 'result'>,
): boolean {
  if (call.toolName === SKIP_REPLY_TOOL_NAME) return isAcceptedSkipReplyResult(call.result);
  return isShortCircuitedToolResult(call.result);
}

/**
 * 已执行 steps 中第一个被拒绝的 skip_reply 的错误码；没有被拒绝的返回 null。
 * 拒绝后本轮必须正常回复，prepareStep 据此屏蔽 skip_reply 并按错误码给出拦截说明，
 * 防止模型换 scene 再次申请沉默。拒绝结果缺 errorType（异常形态）时返回 `'unknown'`。
 */
export function findRejectedSkipReplyErrorType(
  steps: StepLike[],
): ToolErrorType | 'unknown' | null {
  for (const step of steps) {
    const results = step.toolResults;
    if (!Array.isArray(results)) continue;
    for (const tr of results) {
      if (tr.toolName !== SKIP_REPLY_TOOL_NAME) continue;
      if (isAcceptedSkipReplyResult(tr.output)) continue;
      return extractToolErrorType(tr.output) ?? 'unknown';
    }
  }
  return null;
}

/** 已执行 steps 中是否有被拒绝的 skip_reply（见 findRejectedSkipReplyErrorType）。 */
export function hasRejectedSkipReply(steps: StepLike[]): boolean {
  return findRejectedSkipReplyErrorType(steps) !== null;
}

/**
 * skip_reply 被拒绝后拼进 instructions 的拦截说明，按工具错误码分支；未登记的错误码
 * 用通用说明（不编造拒绝原因）。
 */
const SKIP_REPLY_REJECTION_REASONS: Partial<Record<ToolErrorType, string>> = {
  [TOOL_ERROR_TYPES.SKIP_REPLY_HUMAN_TAKEOVER_NOT_ACTIVE]:
    '候选人当前消息之前最近一条经理侧消息是你自己发的，不存在真人正在沟通',
  [TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NO_PRIOR_TURN]:
    '候选人这是首句，你还没有回复过对方，没有可收尾的推进动作',
  [TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK]:
    '候选人当前消息为空、达到 10 字或含问句标记，不满足确认收尾的运行时准入',
};

export function buildSkipReplyRejectedNotice(errorType: ToolErrorType | 'unknown'): string {
  const reason =
    (errorType !== 'unknown' ? SKIP_REPLY_REJECTION_REASONS[errorType] : undefined) ??
    '本轮不满足任何合法沉默场景';
  return (
    `⚠️ 系统拦截：本轮 \`${SKIP_REPLY_TOOL_NAME}\` 已被拒绝（${reason}），不可再调用。` +
    '候选人这条消息是发给你的，请正常回复。'
  );
}

/** booking provenance gate hard-reject 会在 outcome 层转人工。 */
export function isBookingGateRejectedToolCall(
  call: Pick<AgentToolCall, 'toolName' | 'result'>,
): boolean {
  if (call.toolName !== 'duliday_interview_booking') return false;
  const r = asRecord(call.result);
  return r?.shortCircuited === true && (r.gateRejected === true || r.guardrailRejected === true);
}

/** 需要由 outcome 层直接转人工的工具归属/provenance gate hard-reject。 */
export function isHandoffGateRejectedToolCall(
  call: Pick<AgentToolCall, 'toolName' | 'result'>,
): boolean {
  if (isBookingGateRejectedToolCall(call)) return true;
  if (call.toolName !== 'duliday_modify_interview_time') return false;
  const r = asRecord(call.result);
  return r?.shortCircuited === true && r.gateRejected === true;
}

/** 工具结果是否明确被 runtime/tool guardrail 拒绝。 */
export function isGuardrailRejected(result: unknown): boolean {
  const r = asRecord(result);
  return r?.guardrailRejected === true || r?.gateRejected === true;
}

/**
 * 归一后的 AgentToolCall 是否会阻断 replay。
 *
 * 明确成功、在途/未知、未获授权的阻断结果都不能借通用 fallback 重做。
 * 只有明确无副作用的失败仍沿用原有自纠机会；blocked 绝不当作成功。
 */
export function blocksReplay(call: Pick<AgentToolCall, 'toolName' | 'result'>): boolean {
  if (!REPLAY_BLOCKING_TOOLS.has(call.toolName)) return false;
  return replayBlockingStatus(call.result) !== undefined;
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
 * 仅用于成功事实统计，不代表失败/未知动作可以重做。运行时屏蔽统一使用
 * findReplayBlockedSideEffectTools；两者分开，避免把 unknown/blocked 教成成功。
 */
export function findSucceededSideEffectTools(steps: StepLike[]): string[] {
  const succeeded = new Set<string>();
  for (const step of steps) {
    const results = step.toolResults;
    if (!Array.isArray(results)) continue;
    for (const tr of results) {
      const name = tr.toolName;
      if (typeof name !== 'string' || !isSideEffectTool(name)) continue;
      if (isSideEffectCommitted(tr.output)) {
        succeeded.add(name);
        continue;
      }
      if (actionReceiptStatuses(tr.output).length > 0) continue;
      const status = computeToolCallStatus(tr.output, computeResultCount(tr.output));
      if (status === 'ok' || status === 'narrow') succeeded.add(name);
    }
  }
  return [...succeeded];
}

/** Names whose previous action cannot be executed again in this turn. */
export function findReplayBlockedSideEffectTools(steps: StepLike[]): string[] {
  const blocked = new Set<string>();
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      if (
        result.toolName &&
        isSideEffectTool(result.toolName) &&
        replayBlockingStatus(result.output)
      ) {
        blocked.add(result.toolName);
      }
    }
  }
  return [...blocked];
}

/**
 * 构造副作用工具的拦截提示（拼到 system prompt 末尾）。
 */
export function buildSideEffectBlockNotice(blockedTools: string[], steps?: StepLike[]): string {
  if (blockedTools.length === 0) return '';
  return blockedTools
    .map((name) => {
      const outputs = steps?.flatMap((step) =>
        (step.toolResults ?? [])
          .filter((result) => result.toolName === name)
          .map((result) => result.output),
      );
      const unresolved = outputs
        ?.map(replayBlockingStatus)
        .find((status) => status && status !== 'succeeded');
      const reason =
        unresolved === 'blocked' || unresolved === 'cancelled'
          ? '本轮动作未获执行许可或已取消，不能通过换参数/工具兜底绕过'
          : unresolved
            ? '本轮动作仍在执行或结果未知，不能认定失败，也不能再次提交'
            : '本轮已成功执行（副作用已生效）';
      return `⚠️ 系统拦截：工具 \`${name}\` ${reason}，不可重复调用。请按已有业务证据如实收敛回复；未知结果交统一核实恢复，不能宣称成功或提示用户重新提交。`;
    })
    .join('\n');
}

/**
 * 找出本轮已达调用上限的工具名列表。
 *
 * 用于在 prepareStep 中动态屏蔽，让 LLM 在第 4 次想调同一工具时被强制收敛。
 */
export function findToolsExceedingLimit(steps: StepLike[], limit?: number): string[] {
  const counts = countToolCallsByName(steps);
  const exceeded: string[] = [];
  for (const [name, count] of counts.entries()) {
    if (
      count >=
      (limit ?? getBuiltInToolContract(name)?.maxCallsPerTurn ?? MAX_SAME_TOOL_CALLS_PER_TURN)
    )
      exceeded.push(name);
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
