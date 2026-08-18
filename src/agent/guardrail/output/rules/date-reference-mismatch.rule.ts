import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';
import type { AgentToolCall } from '@agent/generator/generator.types';
import { asRecord } from '../output-rule.types';

/**
 * 相对日词与具体日期的一致性对账规则。
 *
 * badcase nau6xunv（chat 6a66f559，2026-07-28）：复聊已正确提醒"今天15:00的视频
 * 面试"，两小时后主链回复却说"你的面试是安排在明天 7 月 28 日 15:00，不是今天哦"
 * ——当天就是 7 月 28 日。候选人被误导停止等待，险些错过当天面试。
 * 同族 b4echyzh：今天下午的面试被说成明天下午。
 *
 * 职责：回复中出现"今天/明天/后天 + (M月D日)"连用时，按当前日期（Asia/Shanghai）
 * 确定性对账；按新规则发牌纪律先以 OBSERVE 入场。
 *
 * 不负责：
 * - 不猜没有具体日期的相对日词（"明天面试"无从对账，交语义层）；
 * - 不校验星期几（周几与日期的映射交语义层）。
 */

// 「大后天」必须独立成词：否则会被交替组里的「后天」从第二个字起吃掉，把 +3 天
// 的正确表述按 +2 天判成错配——列面试时段时「后天/大后天」并排出现是高频话术
//（2026-08-04 生产 chat 6a3ccb21「大后天（8月7日）」即为正确回复，误判即误修）。
// 交替组把「大后天」放在「后天」之前，扫描到「大」时即整词命中，不会留给「后天」。
const RELATIVE_DATE_PATTERN =
  /(大后天|今天|明天|后天)[^。！？\n]{0,6}[（(]?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu;

const RELATIVE_OFFSET: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

function cstYmd(date: Date): { year: number; month: number; day: number } {
  const shifted = new Date(date.getTime() + CST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * 检测"今天/明天/后天 + (M月D日)"与当前日期的矛盾。
 *
 * 跨年容差：只按月/日比对期望日（元旦前后"明天（1月1日）"仍正确对账）。
 */
export function detectDateReferenceMismatch(
  text: string,
  now: Date = new Date(),
  toolCalls: readonly AgentToolCall[] = [],
): RuleContradiction | null {
  for (const match of text.matchAll(RELATIVE_DATE_PATTERN)) {
    const word = match[1];
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isInteger(month) || !Number.isInteger(day)) continue;
    const expected = cstYmd(addDays(now, RELATIVE_OFFSET[word] ?? 0));
    if (expected.month === month && expected.day === day) continue;

    const today = cstYmd(now);
    return {
      ruleId: 'date_reference_mismatch',
      label:
        `回复把 ${month} 月 ${day} 日说成"${word}"，但今天是 ${today.month} 月 ${today.day} 日，` +
        `"${word}"应为 ${expected.month} 月 ${expected.day} 日。日期错乱会误导候选人错过或空等面试，` +
        '必须按真实日历改正相对日词或具体日期',
      action: GUARDRAIL_ACTION.OBSERVE,
    };
  }

  const interviewTime = readGroundedInterviewTime(toolCalls);
  if (!interviewTime) return null;
  const relativeWords = Object.keys(RELATIVE_OFFSET).filter((word) => text.includes(word));
  if (relativeWords.length !== 1) return null;
  const interviewDate = parseStructuredDate(interviewTime);
  if (!interviewDate) return null;
  const word = relativeWords[0];
  const expected = cstYmd(addDays(now, RELATIVE_OFFSET[word] ?? 0));
  if (expected.month === interviewDate.month && expected.day === interviewDate.day) return null;
  return {
    ruleId: 'date_reference_mismatch',
    label:
      `回复使用“${word}”，但本轮结构化工单/预约时间是 ${interviewTime}；` +
      `按消息发送日换算“${word}”应为 ${expected.month} 月 ${expected.day} 日，先观察该错配形态`,
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}

const INTERVIEW_TIME_CONTAINER_KEYS = [
  'duplicateBookingGuard',
  'sameJobActiveOrder',
  'workOrder',
  'booking',
] as const;

function readGroundedInterviewTime(toolCalls: readonly AgentToolCall[]): string | null {
  for (const call of [...toolCalls].reverse()) {
    if (
      call.toolName !== 'duliday_interview_precheck' &&
      call.toolName !== 'duliday_interview_booking' &&
      call.toolName !== 'duliday_modify_interview_time'
    ) {
      continue;
    }
    const result = asRecord(call.result);
    for (const key of INTERVIEW_TIME_CONTAINER_KEYS) {
      const nested = asRecord(result?.[key]);
      const value = nested?.interviewTime;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const resultValue = result?.interviewTime;
    if (typeof resultValue === 'string' && resultValue.trim()) return resultValue.trim();
    const argValue = call.args.interviewTime;
    if (typeof argValue === 'string' && argValue.trim()) return argValue.trim();
  }
  return null;
}

function parseStructuredDate(value: string): { month: number; day: number } | null {
  const datePart = value.trim().replace('T', ' ').split(' ')[0];
  const parts = datePart.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const [, month, day] = parts;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null;
}
