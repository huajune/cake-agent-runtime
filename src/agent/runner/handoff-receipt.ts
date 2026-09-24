import type { AgentToolCall } from '../generator/generator.types';
import { formatInterviewTimeForReply } from '@tools/booking/booking-reply-format.util';

/**
 * 转人工前的「已提交动作回执」（PRD R5.1 第 3 条）。
 *
 * 模型在同一轮里先成功提交了报名/改约/取消，随后又调 request_handoff：工具短路本轮，候选人
 * 什么都收不到，以为没报上/没改成。这里从工具返回的结构化字段拼一段确定性文本，由渠道在
 * 暂停托管之前先投递；不经 LLM、不引用模型文本。
 */
export interface PreHandoffReceipt {
  text: string;
  /** 参与拼接的工具名，观测用。 */
  sources: string[];
}

const BOOKING_TOOL = 'duliday_interview_booking';
const MODIFY_TOOL = 'duliday_modify_interview_time';
const CANCEL_TOOL = 'duliday_cancel_work_order';

export function buildPreHandoffReceipt(toolCalls: AgentToolCall[]): PreHandoffReceipt | undefined {
  const lines: string[] = [];
  const sources: string[] = [];
  for (const call of toolCalls) {
    const result = asRecord(call.result);
    if (!result || result.success !== true) continue;
    let line: string | undefined;
    if (call.toolName === BOOKING_TOOL) line = describeBookingSuccess(result);
    else if (call.toolName === MODIFY_TOOL) line = describeModifySuccess(result);
    else if (call.toolName === CANCEL_TOOL) line = '这次面试预约已经帮你取消了。';
    if (!line) continue;
    lines.push(line);
    sources.push(call.toolName);
  }
  if (lines.length === 0) return undefined;
  return { text: lines.join('\n\n'), sources };
}

function describeBookingSuccess(result: Record<string, unknown>): string {
  const requestInfo = asRecord(result.requestInfo);
  const interviewTime =
    typeof requestInfo?.interviewTime === 'string' ? requestInfo.interviewTime : null;
  const human =
    typeof result._confirmedInterviewTimeHuman === 'string' && interviewTime
      ? result._confirmedInterviewTimeHuman
      : interviewTime
        ? formatInterviewTimeForReply(interviewTime)
        : null;
  const jobLabel = describeJob(result);
  if (!human) {
    return `${jobLabel}报名资料已经提交成功了，这个岗位是等通知的，面试官会电话联系你，请保持电话畅通。`;
  }
  const address =
    typeof result.interviewAddress === 'string' && result.interviewAddress.trim()
      ? `，面试地点：${result.interviewAddress.trim()}`
      : '';
  return `${jobLabel}报名已经提交成功了，面试时间是 ${human}${address}。`;
}

function describeModifySuccess(result: Record<string, unknown>): string | undefined {
  const raw = typeof result.newInterviewTime === 'string' ? result.newInterviewTime.trim() : '';
  if (!raw) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
  return `面试时间已经帮你改到 ${formatInterviewTimeForReply(normalized)} 了，记得准时哈。`;
}

function describeJob(result: Record<string, unknown>): string {
  const parts = [result.brandName, result.storeName, result.jobName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean);
  return parts.length > 0 ? `${parts.join(' ')} 的` : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
