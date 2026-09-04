import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

type AuthoritativeSlot = {
  date: string;
  registrationDeadline: string | null;
};

const EXPIRED_CLAIM_PATTERN =
  /(?:已经|已)?(?:过了|超过|错过)[^，。！？!？\n]{0,8}(?:截止|报名)|(?:截止|报名)[^，。！？!？\n]{0,8}(?:过了|已过|超时)|(?:报名|预约)[^，。！？!？\n]{0,6}(?:(?:已经|已)截止|截止了)|(?:不能|不可|没法|无法|来不及)[^，。！？!？\n]{0,5}(?:报名|预约|约)/u;
const PREVIOUS_DAY_DEADLINE_PATTERN =
  /(?:需要|得|要)?(?:提前一天|前一天)(?:前)?[^，。！？!？\n]{0,8}(?:报名|登记|截止)/u;

function readLatestAuthoritativeSlots(toolCalls: readonly AgentToolCall[]): {
  slots: AuthoritativeSlot[];
  hasRequestedDate: boolean;
} | null {
  for (const call of [...toolCalls].reverse()) {
    if (call.toolName !== 'duliday_interview_precheck' || call.status === 'error') continue;
    const result = asRecord(call.result);
    if (!result || result.success !== true || result.nextAction !== 'select_interview_time')
      continue;

    const interview = asRecord(result.interview);
    if (!interview || !Array.isArray(interview.bookableSlots)) return null;
    const slots = interview.bookableSlots
      .map((value) => asRecord(value))
      .filter((value): value is Record<string, unknown> => Boolean(value))
      .filter((value) => value.bookingAllowed === true && typeof value.date === 'string')
      .map((value) => ({
        date: value.date as string,
        registrationDeadline:
          typeof value.registrationDeadline === 'string' ? value.registrationDeadline : null,
      }))
      .sort((left, right) => left.date.localeCompare(right.date));

    return {
      slots,
      hasRequestedDate: Boolean(asRecord(interview.requestedDate)?.value),
    };
  }
  return null;
}

function dateVariants(date: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return [date];
  const [, year, month, day] = match;
  const numericMonth = String(Number(month));
  const numericDay = String(Number(day));
  return [
    date,
    `${year}/${month}/${day}`,
    `${Number(year)}年${numericMonth}月${numericDay}日`,
    `${numericMonth}月${numericDay}日`,
    `${numericMonth}月${numericDay}号`,
    `${numericMonth}/${numericDay}`,
  ];
}

function mentionsDate(text: string, date: string): boolean {
  return dateVariants(date).some((variant) => text.includes(variant));
}

function clauseContainingDate(text: string, date: string): string | null {
  return text.split(/[，,。！？!？\n；;]/u).find((clause) => mentionsDate(clause, date)) ?? null;
}

function isSameDayDeadline(slot: AuthoritativeSlot): boolean {
  return slot.registrationDeadline?.slice(0, 10) === slot.date;
}

/**
 * precheck 已对完整日期时间和报名截止时间做过一次确定性裁决，生成模型只能渲染结果：
 * - 不得把 bookingAllowed=true 的日期说成已过截止；
 * - 候选人未指定日期时，不得展示后续日期却漏掉最早可约日期；
 * - 同日截止不得改写为“提前一天报名”。
 */
export function detectInterviewSlotAvailabilityMismatch(
  replyText: string,
  toolCalls: readonly AgentToolCall[],
): RuleContradiction | null {
  const authority = readLatestAuthoritativeSlots(toolCalls);
  if (!authority || authority.slots.length === 0) return null;

  for (const slot of authority.slots) {
    const clause = clauseContainingDate(replyText, slot.date);
    if (clause && EXPIRED_CLAIM_PATTERN.test(clause)) {
      return {
        ruleId: 'interview_slot_availability_mismatch',
        label: `precheck 判定 ${slot.date} 可约，回复却在同一分句声称已过截止或不可约`,
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }

  const mentionedSlots = authority.slots.filter((slot) => mentionsDate(replyText, slot.date));
  if (PREVIOUS_DAY_DEADLINE_PATTERN.test(replyText) && mentionedSlots.some(isSameDayDeadline)) {
    return {
      ruleId: 'interview_slot_availability_mismatch',
      label: 'precheck 返回的报名截止日在面试当天，回复却改写为“提前一天报名”',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }

  const earliest = authority.slots[0];
  if (
    !authority.hasRequestedDate &&
    earliest &&
    !mentionsDate(replyText, earliest.date) &&
    authority.slots.slice(1).some((slot) => mentionsDate(replyText, slot.date))
  ) {
    return {
      ruleId: 'interview_slot_availability_mismatch',
      label: `候选人未指定日期，回复展示了后续时段却漏掉 precheck 返回的最早可约日期 ${earliest.date}`,
      action: GUARDRAIL_ACTION.REVISE,
    };
  }

  return null;
}
