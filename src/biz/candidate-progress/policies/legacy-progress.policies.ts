import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  OPEN_RESULT_WORK_ORDER_STATUSES,
  type SignupWorkOrderItem,
} from '@sponge/sponge.types';
import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';
import { parseLocalDateTime } from '@infra/utils/date.util';

/** 迁移期：七个读者保留各自历史窗口，不在重构中合并业务口径。 */
export const BOOKING_SNAPSHOT_SIGNUP_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;
function parseProgressSpongeTime(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return parseLocalDateTime(trimmed)?.getTime() ?? null;
}
export function parseProgressInterviewTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + '+08:00';
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : undefined;
}
/** 状态在途，且（报名近 15 天 或 面试时间在未来）。 */
export function isSnapshotEligibleWorkOrder(order: SignupWorkOrderItem, now: number): boolean {
  const status = order.currentStatus?.trim() ?? '';
  if (!ACTIVE_INTERVIEW_WORK_ORDER_STATUSES.has(status)) return false;
  const signUpAt = parseProgressSpongeTime(order.signUpTime);
  const interviewAt = parseProgressSpongeTime(order.interviewTime);
  const recentSignup = signUpAt != null && now - signUpAt <= BOOKING_SNAPSHOT_SIGNUP_WINDOW_MS;
  const futureInterview = interviewAt != null && interviewAt > now;
  return recentSignup || futureInterview;
}

/**
 * 同岗位在途工单查重窗口。
 *
 * active_booking 是候选人级（corpId + userId）指针，跨托管账号共享：同一候选人同时跟两个
 * 账号聊、另一账号刚建单时，本账号也会命中。booking 与 precheck 必须用**同一条**判据——
 * precheck 先于 booking 亮出在途工单，模型才有机会如实说"已约上"而不是提交后被查重打回。
 */
export const BOOKING_DEDUP_WINDOW_MS = 30 * 60 * 1000;

/**
 * 是否为查重窗口内的同岗位在途工单。`job_id` 为空的存量行按命中处理——老行没记岗位，
 * 宁可让模型核对一张真实工单，也不放行一次重复报名。
 */
export function isRecentSameJobBooking(
  entry: ActiveBookingEntry,
  jobId: number,
  now: number = Date.now(),
): boolean {
  return isRecentBookingPointer(entry, now) && (entry.job_id == null || entry.job_id === jobId);
}

/** 回合装配补读并发指针与报名查重共用严格小于 30 分钟的边界。 */
export function isRecentBookingPointer(
  entry: Pick<ActiveBookingEntry, 'linked_at'>,
  now: number,
): boolean {
  const linkedAt = Date.parse(entry.linked_at);
  return Number.isFinite(linkedAt) && now - linkedAt < BOOKING_DEDUP_WINDOW_MS;
}

/** 列表按 linked_at 倒序（getActiveBookings 契约），首个命中即最近一笔。 */
export function findRecentSameJobBooking(
  entries: readonly ActiveBookingEntry[],
  jobId: number,
  now: number = Date.now(),
): ActiveBookingEntry | undefined {
  return entries.find((entry) => isRecentSameJobBooking(entry, jobId, now));
}

/**
 * pre_booking 带外工单核验（候选人资料证据化 P1「human_oob」确定性切片）。
 *
 * 真人带外操作（手工约面、拒面）与候选人已面试的事实只存在于海绵工单里，而 pre_booking
 * 复聊只认 Agent 自建 terminal 态——不接这道核验就会追问已被拒面/已面试的候选人。
 * post_booking 侧已有到点核验（checkBookingInvalidAtFire），本模块把同一 source of truth
 * 接到 pre_booking 侧。
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
      const interviewAt = parseProgressInterviewTimestamp(order.interviewTime);
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
      const passAt = parseProgressInterviewTimestamp(order.interviewPassTime);
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

/** 复聊报名后到点：只看约面两态，不加时间窗，不 trim（保留旧判据）。 */
export function isLegacyPostBookingActive(status: string | null | undefined): boolean {
  return status != null && ACTIVE_INTERVIEW_WORK_ORDER_STATUSES.has(status);
}
/** 清 booked 前：约面两态及面试成功，不加时间窗。 */
export function hasLegacyOpenWorkOrders(orders: readonly SignupWorkOrderItem[]): boolean {
  return orders.some((order) =>
    OPEN_RESULT_WORK_ORDER_STATUSES.has(order.currentStatus?.trim() ?? ''),
  );
}
/** 复聊终态旧读者；兼容旧记录，但写侧只写 booked。 */
export function legacyTerminalStops(terminal: string | null | undefined, phase: string): boolean {
  return (
    Boolean(terminal) &&
    !(phase === 'post_booking' && (terminal === 'booked' || terminal === 'handed_off'))
  );
}
/** 守卫：任一来源未知且无正证据时，不能把空列表升级为确证没有。 */
export function mergeLegacyGuardBookings(
  snapshot: readonly ActiveBookingEntry[] | undefined,
  pointer: readonly ActiveBookingEntry[] | undefined,
): ActiveBookingEntry[] | undefined {
  const merged = new Map<number, ActiveBookingEntry>();
  for (const entry of [...(snapshot ?? []), ...(pointer ?? [])]) {
    if (!merged.has(entry.work_order_id)) merged.set(entry.work_order_id, entry);
  }
  if (merged.size === 0 && (snapshot === undefined || pointer === undefined)) return undefined;
  return [...merged.values()];
}

function normalizeProgressLabel(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '').trim() : '';
}

export interface SnapshotDuplicateMatch {
  workOrderId: number;
  interviewTime: string | null;
  matchedBy: 'job' | 'brand';
  brandName: string | null;
}

/** 同岗位或同品牌在途即视为重复报名（品牌比较忽略大小写与空白）。 */
export function findSnapshotDuplicate<
  T extends {
    jobId: number | null;
    brandName?: string | null;
    workOrderId: number;
    interviewTime?: string | null;
  },
>(
  entries: readonly T[],
  target: { jobId: number; brandName?: string | null },
): SnapshotDuplicateMatch | undefined {
  const targetBrand = normalizeProgressLabel(target.brandName).toLowerCase();
  for (const entry of entries) {
    if (entry.jobId != null && entry.jobId === target.jobId) {
      return {
        workOrderId: entry.workOrderId,
        interviewTime: entry.interviewTime ?? null,
        matchedBy: 'job',
        brandName: entry.brandName ?? null,
      };
    }
  }
  if (!targetBrand) return undefined;
  for (const entry of entries) {
    if (normalizeProgressLabel(entry.brandName).toLowerCase() === targetBrand) {
      return {
        workOrderId: entry.workOrderId,
        interviewTime: entry.interviewTime ?? null,
        matchedBy: 'brand',
        brandName: entry.brandName ?? null,
      };
    }
  }
  return undefined;
}
