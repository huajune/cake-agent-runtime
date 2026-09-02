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
 * - 将来时（"我帮你约"）、征询（"要帮你约吗"）不在口径内；条件从句（"报名成功**后**会发你
 *   面试码"）同样不在口径内——"成功"在这里是尚未发生的前提而非回执，故 `成功` 后紧跟
 *   `后/之后/以后/後/的话` 时不判命中。
 *
 * 已知残余风险：跨轮提醒（前几轮已真实建单，本轮零工具复述"已帮你约好"）会命中。
 * 因此按目录发牌纪律 OBSERVE 入场，先落档累计判例分辨"假宣称 vs 合法提醒"的占比，
 * 满足升档门槛（≥2 周判例、精确率 ≥90%）再申请动手权。
 */
const BOOKING_DONE_CLAIM_PATTERN =
  /已(?:经)?(?:帮你|给你|替你)(?:报好名?|报上名?|提交(?:了)?(?:报名|预约)|报名|预约|登记好|约好)|(?:报名|预约)(?:已(?:经)?)?(?:提交成功|成功)(?!后|之后|以后|後|的话)|已(?:经)?(?:报好名|登记好)/u;

const BOOKING_FAMILY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'duliday_interview_booking',
  'duliday_modify_interview_time',
]);

/**
 * precheck 是否返回在途工单——完成时态此时是对既有工单的复述，不是假宣称。
 *
 * `asRecord` 收窄失败时返回 `null` 而非 `undefined`，所以判空必须比 `null`：
 * 比 `undefined` 会让**任何**带 precheck 的回合都被豁免，等于把哨兵对整条预约主链路关掉。
 */
function hasActiveWorkOrderEvidence(toolCalls: readonly AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'duliday_interview_precheck') return false;
    return asRecord(asRecord(call.result)?.duplicateBookingGuard) !== null;
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

/**
 * 取消/改期完成时态宣称 ↔ 工单动作对账。
 *
 * 自助取消/改期失败时的正确出口是转人工（见 request-handoff 工具描述），但模型会照常
 * 宣称"我帮你取消了"。候选人据此不再到店 = 爽约，代价与到店扑空同级，故失败态按
 * 硬矛盾处理。
 *
 * 两档判据：
 * - **REVISE（硬矛盾）**：本轮调了 cancel/modify 且**全部失败**，回复却给出任何"取消已办/这就
 *   帮你取消"的安抚。失败轮里将来时同样是谎——候选人照样不会到店，故此档口径比下面宽。
 *   本轮自证工具没成功，不存在"跨轮复述"的解释空间，误判面接近零。
 * - **OBSERVE（弱信号）**：本轮零 cancel/modify 调用却宣称已取消。与
 *   `booking_done_claim_without_submission` 同一残余风险——跨轮合法提醒会命中，
 *   先累计判例再议升档。
 */
const CANCEL_DONE_CLAIM_PATTERN =
  /已(?:经)?(?:帮你|给你|替你)?(?:取消|退掉|撤销)(?:了|好了|掉了|成功)?|(?:取消|改期|改约)(?:已(?:经)?)?成功(?!后|之后|以后|後|的话)|(?:面试|预约|报名|工单)(?:已(?:经)?)(?:取消|撤销)/u;

/** 失败轮专用的宽口径：完成时态之外，"我帮你取消/这就取消"的将来时安抚同样不可发送。 */
const CANCEL_REASSURANCE_PATTERN =
  /(?:帮|给|替)你(?:先)?(?:取消|退掉|撤销)|(?:取消|撤销)(?:了|好了|掉了|成功)|(?:面试|预约|报名|工单).{0,6}(?:取消|撤销)/u;

const CANCEL_FAMILY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
]);

export function detectCancelDoneClaimWithoutSubmission(
  text: string,
  toolCalls: AgentToolCall[] = [],
): RuleContradiction | null {
  if (!text.trim()) return null;

  const cancelCalls = toolCalls.filter((call) => CANCEL_FAMILY_TOOL_NAMES.has(call.toolName));

  // 失败轮：只要有一次成功就是合法回执；全失败才是硬矛盾，且口径放宽到将来时安抚。
  if (cancelCalls.length > 0) {
    if (cancelCalls.some((call) => call.status !== 'error')) return null;
    if (!CANCEL_REASSURANCE_PATTERN.test(text)) return null;
    return {
      ruleId: 'cancel_done_claim_failed_tool',
      label:
        '本轮 duliday_cancel_work_order / duliday_modify_interview_time 全部调用失败，回复却宣称' +
        '已取消/已改期或承诺这就取消——候选人据此不到店即爽约，必须改成如实告知并转人工',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }

  if (CANCEL_DONE_CLAIM_PATTERN.test(text)) {
    return {
      ruleId: 'cancel_done_claim_without_submission',
      label:
        '回复用完成时态宣称面试已取消/已改期，但本轮没有任何 duliday_cancel_work_order / ' +
        'duliday_modify_interview_time 调用',
      action: GUARDRAIL_ACTION.OBSERVE,
    };
  }

  return null;
}
