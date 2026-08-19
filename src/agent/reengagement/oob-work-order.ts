import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  type SignupWorkOrderItem,
} from '@sponge/sponge.types';
import { parseInterviewTimestamp } from './scenario-registry';

/**
 * pre_booking 带外工单核验（候选人资料证据化 P1「human_oob」确定性切片）。
 *
 * 背景（badcase recvqgvKqRAcKg/recvqgw2wm58yF/recvqgxF51YhD8，2026-07-24）：
 * 真人招募经理带外操作（手工约面、拒绝面试）或候选人已面试的事实只存在于海绵
 * 工单里，pre_booking 复聊场景只认 Agent 自建 terminal 态，对带外工单全盲——
 * 已被经理拒面/已面试过的候选人仍被持续追问"要不要看看别的岗"。
 * post_booking 场景已有到点核验（checkBookingInvalidAtFire），本模块把同一
 * source of truth（海绵工单）接到 pre_booking 侧。
 *
 * 判定纯确定性（工单状态 + 时间窗），无 LLM：
 * - 约面待确认 / 约面成功：带外报名在途 → 停。仅当工单面试时间已过去超过
 *   {@link STALE_ACTIVE_ORDER_MS}（状态未推进的僵尸单）才放行；无面试时间
 *   （等通知单）视为在途。
 * - 面试成功：近 {@link RECENT_PASS_WINDOW_MS} 内通过（或无通过时间无法判旧）→ 停；
 *   更早的通过不拦（候选人可能重新找工作）。
 * - 上岗成功：在职中 → 停（离职会转"已离职"态）。
 * - 约面失败 / 约面取消 / 面试失败 / 上岗失败 / 已离职：流程已终结且候选人
 *   仍可求职 → 不停，pre_booking 维护合理。
 *
 * 降级语义（调用方执行）：无手机号或海绵查询失败按放行处理——pre_booking
 * 历史上本就没有这道闸，fail open 只是维持现状，不让海绵抖动放大成全量静默。
 */

/** 进行中约面工单：面试时间已过去超过该窗口仍未推进状态，视为僵尸单放行。 */
const STALE_ACTIVE_ORDER_MS = 3 * 24 * 60 * 60 * 1000;

/** 面试通过后的静默窗口：窗口内不做 pre_booking 维护性触达。 */
const RECENT_PASS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 状态词表单点在 sponge（海绵领域语言）；本文件的 trim 比较预处理原样保留。 */
const ACTIVE_STATUSES = ACTIVE_INTERVIEW_WORK_ORDER_STATUSES;

export interface OutOfBandWorkOrderVerdict {
  stop: true;
  /** trackStopped 落底账的原因（oob_ 前缀标识带外工单族）。 */
  reason: string;
  workOrderId?: number | null;
}

export function evaluateOutOfBandWorkOrders(
  orders: ReadonlyArray<SignupWorkOrderItem>,
  now: number,
): OutOfBandWorkOrderVerdict | null {
  for (const order of orders) {
    const status = order.currentStatus?.trim();
    if (!status) continue;

    if (ACTIVE_STATUSES.has(status)) {
      const interviewAt = parseInterviewTimestamp(order.interviewTime);
      const stale = interviewAt !== undefined && now - interviewAt > STALE_ACTIVE_ORDER_MS;
      if (!stale) {
        return {
          stop: true,
          reason: `oob_work_order_active:${status}`,
          workOrderId: order.workOrderId,
        };
      }
      continue;
    }

    if (status === '面试成功') {
      const passAt = parseInterviewTimestamp(order.interviewPassTime);
      const recentOrUnknown = passAt === undefined || now - passAt <= RECENT_PASS_WINDOW_MS;
      if (recentOrUnknown) {
        return {
          stop: true,
          reason: 'oob_work_order_progressed:面试成功',
          workOrderId: order.workOrderId,
        };
      }
      continue;
    }

    if (status === '上岗成功') {
      return {
        stop: true,
        reason: 'oob_work_order_progressed:上岗成功',
        workOrderId: order.workOrderId,
      };
    }
  }
  return null;
}
