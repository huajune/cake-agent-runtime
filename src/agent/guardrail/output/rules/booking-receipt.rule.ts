import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * booking 回执对账（badcase recvoFsFPZHTxw / 7-27 复测 RT-016 第二失败形态）。
 *
 * booking 成功的 _replyInstruction 播报硬指令是 prompt 层约束，已被生产实测击穿：
 * 工单真实建单后回复仍问「你定哪一天」（候选人以为没约上，重复提交撞 already_booked，
 * badcase yfrc6wb9 同族）。本规则做确定性对账——本轮 duliday_interview_booking
 * success=true 是不可逆副作用，回复必须与它一致：
 *
 * - 形态 A（REVISE，近零假阳）：预约已提交却仍在向候选人征询日期/时刻
 *   （「你定哪天/几号方便/什么时候有空」）——直接与已提交的工单矛盾；
 * - 形态 B（OBSERVE）：回复完全未提报名/预约结果（一个报名类词都没有）——
 *   播报缺失，候选人不知已报名；表述方式多样，先 observe 落档累计精确率。
 */
const DATE_ASK_PATTERN =
  /(?:你|您)(?:定|看|选|挑)[^，。！？!?\n]{0,6}(?:哪一?天|几号|几点|什么时候|时间)|(?:哪一?天|几号|几点|什么时候)[^，。！？!?\n]{0,4}(?:方便|有空|合适|可以|行)[^，。！？!?\n]{0,4}[？?]?|(?:选|挑|定)(?:个|一个)[^，。！？!?\n]{0,4}(?:时间|日子|时段)/u;

const BOOKING_MENTION_PATTERN = /报名|预约|登记|约好|约上|已(?:帮你)?约|帮你约|面试|工单/u;

// 已确认口径：回复明确播报了"已约好/已登记/报名成功"。窗口制岗位"已帮你约好周四，
// 你几点方便到店"是合法话术——确认在场时的时间征询不算回执矛盾。
const CONFIRMATION_PATTERN =
  /已(?:经)?(?:帮你|给你)?(?:约|报名|登记|提交|预约)|(?:约|登记|报名|预约)(?:好|上|成功)|帮你(?:约|报)(?:好|上)/u;

function findSuccessfulBooking(toolCalls: AgentToolCall[]): AgentToolCall | null {
  for (const call of toolCalls) {
    if (call.toolName !== 'duliday_interview_booking' || call.status === 'error') continue;
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : null;
    if (result?.success === true) return call;
  }
  return null;
}

export function detectBookingReceiptMismatch(
  replyText: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const booking = findSuccessfulBooking(toolCalls);
  if (!booking || !replyText.trim()) return null;

  if (DATE_ASK_PATTERN.test(replyText) && !CONFIRMATION_PATTERN.test(replyText)) {
    return {
      ruleId: 'booking_receipt_mismatch',
      label:
        '本轮 duliday_interview_booking 已成功提交工单，回复却仍在向候选人征询面试日期/时间' +
        '——与已提交的预约直接矛盾，候选人会以为没约上而重复提交或流失',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }

  if (!BOOKING_MENTION_PATTERN.test(replyText)) {
    return {
      ruleId: 'booking_receipt_mismatch',
      label:
        '本轮 duliday_interview_booking 已成功提交工单，回复却完全未向候选人播报报名结果' +
        '（badcase yfrc6wb9：候选人不知已报名，重复提交撞 already_booked）',
      action: GUARDRAIL_ACTION.OBSERVE,
    };
  }

  return null;
}
