import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  type SignupWorkOrderItem,
  type SignupWorkOrdersResult,
} from '@sponge/sponge.types';
import type { SpongeService } from '@sponge/sponge.service';
import type { SpongeTokenResolveContext } from '@sponge/sponge-token.config';
import { parseLocalDateTime } from '@infra/utils/date.util';
import { toErrorMessage } from '@infra/utils/error.util';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { normalizeJobId } from '@resolution/job';
import type { BookingSnapshotEntry, BookingSnapshotSignupSource } from './booking-snapshot.types';

/** 快照本地时间窗：报名近 15 天，或面试时间在未来（服务端按报名时间过滤会漏掉老报名新面试）。 */
export const BOOKING_SNAPSHOT_SIGNUP_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

/** 快照缓存 TTL（秒）。 */
export const BOOKING_SNAPSHOT_CACHE_TTL_SECONDS = 5 * 60;

/** 单次海绵查询超时。 */
export const BOOKING_SNAPSHOT_FETCH_TIMEOUT_MS = 3_000;

export function normalizeCandidateName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '').trim() : '';
}

/**
 * 本人校验（确定性、fail-closed）：海绵登记姓名与会话事实/长期档案里任一姓名完全一致才算本人。
 * 任一侧为空都判 false——代报同行人的手机号会被当成本人落进档案，姓名是唯一能区分的锚。
 */
export function isWorkOrderOwnedByCandidate(
  sponge: { rowCandidateName?: string | null; topCandidateName?: string | null },
  known: ReadonlyArray<string | null | undefined>,
): boolean {
  const spongeName =
    normalizeCandidateName(sponge.rowCandidateName) ||
    normalizeCandidateName(sponge.topCandidateName);
  if (!spongeName) return false;
  return known.some((name) => normalizeCandidateName(name) === spongeName);
}

export function normalizeSignupSource(value: unknown): BookingSnapshotSignupSource {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return text === 'AI' || text === 'SUPPLIER' ? text : null;
}

function parseSpongeTime(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = parseLocalDateTime(trimmed);
  return parsed ? parsed.getTime() : null;
}

/** 状态在途，且（报名近 15 天 或 面试时间在未来）。 */
export function isSnapshotEligibleWorkOrder(order: SignupWorkOrderItem, now: number): boolean {
  const status = order.currentStatus?.trim() ?? '';
  if (!ACTIVE_INTERVIEW_WORK_ORDER_STATUSES.has(status)) return false;
  const signUpAt = parseSpongeTime(order.signUpTime);
  const interviewAt = parseSpongeTime(order.interviewTime);
  const recentSignup = signUpAt != null && now - signUpAt <= BOOKING_SNAPSHOT_SIGNUP_WINDOW_MS;
  const futureInterview = interviewAt != null && interviewAt > now;
  return recentSignup || futureInterview;
}

export function toBookingSnapshotEntry(
  order: SignupWorkOrderItem,
  params: { topCandidateName: string | null; knownNames: ReadonlyArray<string | null | undefined> },
): BookingSnapshotEntry {
  const rowName = typeof order.candidateName === 'string' ? order.candidateName.trim() : '';
  return {
    workOrder: order,
    workOrderId: order.workOrderId,
    jobId: normalizeJobId(order.jobId),
    brandName:
      typeof order.brandName === 'string' && order.brandName.trim() ? order.brandName.trim() : null,
    jobName:
      typeof order.jobName === 'string' && order.jobName.trim() ? order.jobName.trim() : null,
    interviewTime: order.interviewTime?.trim() || null,
    signUpTime: order.signUpTime?.trim() || null,
    signupSource: normalizeSignupSource(order.signupSource),
    candidateName: rowName || params.topCandidateName,
    ownedByCandidate: isWorkOrderOwnedByCandidate(
      { rowCandidateName: rowName, topCandidateName: params.topCandidateName },
      params.knownNames,
    ),
  };
}

/** 面试时间戳（毫秒）；等通知单返回 null。 */
export function snapshotInterviewAt(
  entry: Pick<BookingSnapshotEntry, 'interviewTime'>,
): number | null {
  return parseSpongeTime(entry.interviewTime);
}

/** 海绵报名时间戳（毫秒）；缺失返回 null。 */
export function snapshotSignUpAt(entry: Pick<BookingSnapshotEntry, 'signUpTime'>): number | null {
  return parseSpongeTime(entry.signUpTime);
}

/**
 * 稳定对账锚点：同工单同面试时间只排一次；面试时间变化（含由空变有值）即换锚点重排。
 * 与复聊解析任务的去重键同源，禁止再拼每轮不同的 traceId。
 */
export function buildReconcileAnchorKey(
  entry: Pick<BookingSnapshotEntry, 'workOrderId' | 'interviewTime'>,
  suffix?: 'resumed',
): string {
  const iv = (entry.interviewTime ?? 'none').replace(/\s+/g, '_');
  return `reconcile:wo${entry.workOrderId}:iv${iv}${suffix ? `:${suffix}` : ''}`;
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
  const targetBrand = normalizeCandidateName(target.brandName).toLowerCase();
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
    if (normalizeCandidateName(entry.brandName).toLowerCase() === targetBrand) {
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

/**
 * 跨托管账号查重：报名前再查一次 `onlyCurrentAccount=false`（只读），同岗位或同品牌在途即命中。
 * 只用本会话账号 token（禁止回退默认 token）、3 秒超时；查询失败按无命中放行并交由 onFailure 记录，
 * 海绵提交侧的判重仍会兜底拒绝。
 */
export async function findCrossAccountDuplicate(params: {
  spongeService: Pick<SpongeService, 'fetchSignupWorkOrders'>;
  phone: string | null | undefined;
  tokenContext: SpongeTokenResolveContext | undefined;
  target: { jobId: number; brandName?: string | null };
  now?: number;
  onFailure?: (message: string) => void;
}): Promise<SnapshotDuplicateMatch | undefined> {
  const phone = params.phone?.trim() ?? '';
  if (!isStorableCandidatePhone(phone) || !params.tokenContext?.botImId) return undefined;
  let result: SignupWorkOrdersResult;
  try {
    result = await params.spongeService.fetchSignupWorkOrders(
      {
        phone,
        onlyCurrentAccount: false,
        queryParam: { currentStatus: Array.from(ACTIVE_INTERVIEW_WORK_ORDER_STATUSES) },
      },
      params.tokenContext,
      { timeoutMs: BOOKING_SNAPSHOT_FETCH_TIMEOUT_MS, allowDefaultToken: false },
    );
  } catch (error) {
    params.onFailure?.(toErrorMessage(error));
    return undefined;
  }
  const now = params.now ?? Date.now();
  const entries = (result?.workOrders ?? [])
    .filter((order) => isSnapshotEligibleWorkOrder(order, now))
    .map((order) => ({
      workOrderId: order.workOrderId,
      jobId: normalizeJobId(order.jobId),
      brandName: typeof order.brandName === 'string' ? order.brandName : null,
      interviewTime: order.interviewTime?.trim() || null,
    }));
  return findSnapshotDuplicate(entries, params.target);
}
