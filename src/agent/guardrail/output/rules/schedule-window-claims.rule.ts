import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

const SCHEDULE_ASSURANCE_PATTERN =
  /(?:协调|可以|能|可)(?:给你|跟店里|和门店)?(?:排|安排)|一般没问题|不会强制|不用上到|不用做到/u;

const TIME_RANGE_PATTERN =
  /(?<!\d)(\d{1,2})(?::([0-5]\d)|点(?:半)?|时)?\s*(?:-|到|至|~|—|–)\s*(?:次日\s*)?(\d{1,2})(?::([0-5]\d)|点(?:半)?|时)?(?!\d)/gu;

function toMinutes(hourText: string, minuteText: string | undefined): number | null {
  const hour = Number(hourText);
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null;
  const minute = minuteText && /^\d{2}$/.test(minuteText) ? Number(minuteText) : 0;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

function extractTimeRanges(text: string): Set<string> {
  const ranges = new Set<string>();
  for (const match of text.matchAll(TIME_RANGE_PATTERN)) {
    const start = toMinutes(match[1], match[2]);
    const end = toMinutes(match[3], match[4]);
    if (start === null || end === null) continue;
    ranges.add(`${start}-${end}`);
  }
  return ranges;
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result ?? '');
  } catch {
    return '';
  }
}

/**
 * 岗位工具列出明确班次后，禁止承诺一个工具未列出的自定义时段。
 *
 * 规则刻意收窄到“时间段 + 可协调/没问题”承诺，不拦普通的候选人时间复述，
 * 也不试图恢复已经下线的宽泛 schedule fact 规则。
 */
export function detectUnsupportedScheduleWindowClaim(
  replyText: string,
  toolCalls: AgentToolCall[],
  currentFocusJobId?: number,
): RuleContradiction | null {
  if (!SCHEDULE_ASSURANCE_PATTERN.test(replyText)) return null;
  const claimedRanges = extractTimeRanges(replyText);
  if (claimedRanges.size === 0) return null;

  const relevantCalls = toolCalls.filter((call) => {
    if (call.toolName !== 'duliday_job_list' || call.status === 'error') return false;
    if (!currentFocusJobId) return true;
    const ids = Array.isArray(call.args?.jobIdList) ? call.args.jobIdList : [];
    return ids.some((id) => Number(id) === currentFocusJobId);
  });
  if (relevantCalls.length === 0) return null;

  const supportedRanges = new Set<string>();
  for (const call of relevantCalls) {
    for (const range of extractTimeRanges(stringifyResult(call.result))) supportedRanges.add(range);
  }
  const unsupported = [...claimedRanges].filter((range) => !supportedRanges.has(range));
  if (unsupported.length === 0) return null;

  return {
    ruleId: 'unsupported_schedule_window_claim',
    label:
      '回复承诺可协调的工作时段未出现在当前岗位查询结果中；只能转述工具列出的班次，' +
      '候选人无法满足时应说明需门店确认或改推匹配岗位',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
