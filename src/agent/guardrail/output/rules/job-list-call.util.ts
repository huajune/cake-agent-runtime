import type { AgentToolCall } from '@agent/generator/generator.types';

/**
 * duliday_job_list 调用可用性共享原语。
 *
 * "可用" = 是 job_list 调用且有结果、非空、非错：empty/error/resultCount=0 不算接地，
 * 否则模型可能拿空结果继续编岗位。
 *
 * 接地类判定必须能扫描本轮**全部** job_list 调用，不能只看最后一次：Agent 常见动作链
 * 是"近距离查（空）→ 全市扩面查（有结果）→ 带 jobId 复核（空）"，岗位事实接地在中间
 * 那次。生产假阳（2026-07-06 守卫档案 id=3）：全市查询真实返回了必胜客/肯德基，却因
 * 最后一次调用为空被判未接地，整轮推荐被杀。
 *
 * 此前同一份"可用"口径在 job-fact-hallucinations / job-fact-value-mismatch 各存一份、
 * brand-name-errors 还停在"裸最后一次"语义（2026-07-06 review），收敛到这里防漂移。
 */
export function isUsableJobListCall(call: AgentToolCall | null | undefined): boolean {
  if (!call || call.toolName !== 'duliday_job_list') return false;
  if (!call.result) return false;
  if (call.resultCount === 0) return false;
  if (call.status === 'error' || call.status === 'empty') return false;
  return true;
}

/** 本轮是否存在任一"可用"的 job_list 结果（接地存在性判定）。 */
export function hasUsableJobListResult(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some((call) => isUsableJobListCall(call));
}

/** 最后一次"可用"的 job_list 结果：事实对账类规则应对齐它，而不是最后一次调用（可能为空）。 */
export function readLatestUsableJobListCall(toolCalls: AgentToolCall[]): AgentToolCall | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (isUsableJobListCall(call)) return call;
  }
  return null;
}

/**
 * 最后一次 job_list 调用（不问可用与否）：只用于读 errorType / aliasFuzzyMatch 等
 * **错误侧**信号——这些信号恰恰长在空/错结果上，改用"可用"口径会读不到。
 */
export function readLatestJobListCall(toolCalls: AgentToolCall[]): AgentToolCall | null {
  return [...toolCalls].reverse().find((call) => call.toolName === 'duliday_job_list') ?? null;
}
