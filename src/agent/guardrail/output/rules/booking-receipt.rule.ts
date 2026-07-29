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

function findSuccessfulJobPoolInvite(toolCalls: AgentToolCall[]): AgentToolCall | null {
  for (const call of toolCalls) {
    if (call.toolName !== 'invite_to_group' || call.status === 'error') continue;
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : null;
    if (result?.success === true && result.groupPurpose === 'job_pool') return call;
  }
  return null;
}

function requiresManualInterviewGroup(booking: AgentToolCall): boolean {
  const result =
    booking.result && typeof booking.result === 'object' && !Array.isArray(booking.result)
      ? (booking.result as Record<string, unknown>)
      : null;
  const handling =
    result?.interviewGroupHandling &&
    typeof result.interviewGroupHandling === 'object' &&
    !Array.isArray(result.interviewGroupHandling)
      ? (result.interviewGroupHandling as Record<string, unknown>)
      : null;
  return handling?.required === true && handling.delivery === 'manual';
}

const INTERVIEW_GROUP_COMPLETION_CLAIM_PATTERN =
  /面试群[^。！？\n]{0,18}(?:已经|已|刚)[^。！？\n]{0,10}(?:发|拉|邀请)|(?:已经|已|刚)[^。！？\n]{0,12}(?:发|拉|邀请)[^。！？\n]{0,12}面试群/u;
const INTERVIEW_GROUP_IDENTITY_SPLIT_PATTERN =
  /(?:工作人员|运营|人工|机器人|同事)[^。！？\n]{0,16}(?:发|拉|邀请|处理|接手)|(?:转交|转给|切换|接管)[^。！？\n]{0,12}(?:工作人员|运营|人工|同事)/u;
const MEETING_GROUP_PROMISE_PATTERN = /腾讯会议|会议链接|按时入会|上线入会/u;
const GROUP_PURPOSE_DISTINCTION_PATTERN =
  /兼职[^。！？\n]{0,30}(?:群|岗位信息)[\s\S]{0,100}面试群[\s\S]{0,40}(?:接着|随后|稍后|单独)[^。！？\n]{0,12}(?:发|邀请)|面试群[\s\S]{0,40}(?:接着|随后|稍后|单独)[^。！？\n]{0,12}(?:发|邀请)[\s\S]{0,100}兼职[^。！？\n]{0,30}(?:群|岗位信息)/u;

export function detectBookingReceiptMismatch(
  replyText: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const booking = findSuccessfulBooking(toolCalls);
  if (!booking || !replyText.trim()) return null;

  if (requiresManualInterviewGroup(booking)) {
    if (INTERVIEW_GROUP_IDENTITY_SPLIT_PATTERN.test(replyText)) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label:
          '面试群补发由当前企微账号无感承接，回复却出现工作人员/运营/人工/同事接手等身份切换表述，' +
          '会暴露账号背后的执行切换',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }

    if (INTERVIEW_GROUP_COMPLETION_CLAIM_PATTERN.test(replyText)) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label:
          '本岗位面试群只能由当前企微账号随后手动发送，回复却声称面试群已经发送/已拉入；' +
          '这会把未来动作说成已完成',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }

    const jobPoolInvite = findSuccessfulJobPoolInvite(toolCalls);
    if (
      jobPoolInvite &&
      MEETING_GROUP_PROMISE_PATTERN.test(replyText) &&
      !GROUP_PURPOSE_DISTINCTION_PATTERN.test(replyText)
    ) {
      return {
        ruleId: 'booking_receipt_mismatch',
        label:
          '本轮 invite_to_group 发送的是兼职岗位信息群，回复却没有把它与待手动发送的面试群区分，' +
          '容易让候选人误以为兼职群会发送腾讯会议链接',
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }

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
