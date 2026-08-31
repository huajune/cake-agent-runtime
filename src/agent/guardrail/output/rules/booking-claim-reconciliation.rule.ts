import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';
import { asRecord } from '../output-rule.types';

/**
 * 报名完成时态宣称 ↔ 提交动作对账哨兵。
 *
 * 背景：规则简化改造下线了 `booking_promise_without_booking`
 * ——生产 7 天抽样证实其将来时口径几乎全部命中"资料发我，我帮你约"的合法收资话术
 * （约 60 次/天假阳），不予恢复。但它退场后，**零调用却用完成时态宣称"已帮你报好/
 * 报名成功"** 的假宣称失去了唯一确定性哨兵：booking_receipt_mismatch 只对账本轮
 * 存在 booking 调用的路径，Prompt 侧 B-5 只能教不能拦。
 *
 * 职责边界（与既有规则正交）：
 * - 本轮存在任何 duliday_interview_booking 调用（无论成败）→ 一律让位给
 *   booking_receipt_mismatch，绝不双记账；
 * - 本轮成功改约（duliday_modify_interview_time）→"已帮你约到/改到"是合法回执；
 * - precheck 返回在途工单（duplicateBookingGuard）→ 完成时态是对既有工单的合法复述；
 * - 将来时（"我帮你约"）、征询（"要帮你约吗"）不在口径内。
 *
 * 已知残余风险：跨轮提醒（前几轮已真实建单，本轮零工具复述"已帮你约好"）会命中。
 * 因此按目录发牌纪律 OBSERVE 入场，先落档累计判例分辨"假宣称 vs 合法提醒"的占比，
 * 满足升档门槛（≥2 周判例、精确率 ≥90%）再申请动手权。
 */
const BOOKING_DONE_CLAIM_PATTERN =
  /已(?:经)?(?:帮你|给你|替你)(?:报好名?|报上名?|提交(?:了)?(?:报名|预约)|报名|预约|登记好|约好)|(?:报名|预约)(?:已(?:经)?)?(?:成功|提交成功)|已(?:经)?(?:报好名|登记好)/u;

const BOOKING_FAMILY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'duliday_interview_booking',
  'duliday_modify_interview_time',
]);

/** precheck 是否返回在途工单——完成时态此时是对既有工单的复述，不是假宣称。 */
function hasActiveWorkOrderEvidence(toolCalls: readonly AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'duliday_interview_precheck') return false;
    return asRecord(asRecord(call.result)?.duplicateBookingGuard) !== undefined;
  });
}

export function detectBookingDoneClaimWithoutSubmission(
  text: string,
  toolCalls: AgentToolCall[] = [],
): RuleContradiction | null {
  if (!text.trim()) return null;
  if (!BOOKING_DONE_CLAIM_PATTERN.test(text)) return null;
  if (toolCalls.some((call) => BOOKING_FAMILY_TOOL_NAMES.has(call.toolName))) return null;
  if (hasActiveWorkOrderEvidence(toolCalls)) return null;

  return {
    ruleId: 'booking_done_claim_without_submission',
    label:
      '回复用完成时态宣称报名/预约已办好（"已帮你报好/报名成功"），但本轮没有任何 ' +
      'duliday_interview_booking / duliday_modify_interview_time 调用，precheck 也未返回在途工单',
    action: GUARDRAIL_ACTION.OBSERVE,
  };
}
