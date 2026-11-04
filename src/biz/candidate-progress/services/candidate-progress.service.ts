import { Injectable, Optional } from '@nestjs/common';
import { LongTermService } from '@memory/long-term/long-term.service';
import { isUserProfileFactValue, type ActiveBookingEntry } from '@memory/long-term/long-term.types';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { SessionWorkbenchService } from '@memory/short-term/workbench.service';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { SpongeService } from '@sponge/sponge.service';
import type { SignupWorkOrderItem } from '@sponge/sponge.types';
import {
  BookingSnapshotService,
  type BookingSnapshotLoadInput,
} from '@tools/booking/booking-snapshot.service';
import type { BookingSnapshotLoadResult } from '@tools/booking/booking-snapshot.types';
import { AgentTracerService } from '@observability/agent-tracer.service';
import {
  evaluateOutOfBandWorkOrders,
  hasLegacyOpenWorkOrders,
  isSnapshotEligibleWorkOrder,
  mergeLegacyGuardBookings,
  type OutOfBandWorkOrderVerdict,
} from '../policies/legacy-progress.policies';
import type {
  ProgressOrderSource,
  ProgressPhoneSource,
  ProgressReadMode,
  ProgressReader,
  ProgressTruth,
} from '@shared-types/candidate-progress.types';
import {
  PROGRESS_ORDER_SOURCE,
  PROGRESS_PHONE_SOURCE,
  PROGRESS_POLICY,
  PROGRESS_READER,
  PROGRESS_READ_MODE,
  PROGRESS_TRUTH,
} from '@shared-types/candidate-progress.types';

export type { ProgressTruth } from '@shared-types/candidate-progress.types';
export interface CandidateProgressScope {
  corpId: string;
  userId: string;
  chatId: string;
  botImId?: string;
  botUserId?: string;
}
export interface CandidateProgressView {
  scope: CandidateProgressScope;
  mode: ProgressReadMode;
  /** 未指定统一窗口前只启用 legacy；comparison 仅提供评审证据。 */
  policy: typeof PROGRESS_POLICY.LEGACY;
  active: ProgressTruth;
  phone: { value: string | null; source: ProgressPhoneSource };
  workOrders: readonly SignupWorkOrderItem[];
  orders: ReadonlyArray<{
    workOrderId: number;
    jobId: number | null;
    brandName: string | null;
    status: string | null;
    interviewTime: string | null;
    ownedByCurrentAccount: ProgressTruth;
    source: ProgressOrderSource;
  }>;

  pointers: readonly ActiveBookingEntry[] | null;
  group: { invited: ProgressTruth; verified: false };
  stage: { value: string | null; fallback: boolean };
  outOfBandVerdict: OutOfBandWorkOrderVerdict | null;
}

/** 只读投影：人级工单与聊天级控制明确分开，外部失败不伪造成零工单。 */
@Injectable()
export class CandidateProgressService {
  constructor(
    private readonly longTerm: LongTermService,
    private readonly session: SessionStateService,
    private readonly workbench: SessionWorkbenchService,
    private readonly sponge: SpongeService,
    private readonly snapshot: BookingSnapshotService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  /** 回合装配保留原快照及缓存策略；在同一批原始数据上并行记录窗口差异。 */
  async loadBookingSnapshot(input: BookingSnapshotLoadInput): Promise<BookingSnapshotLoadResult> {
    const result = await this.snapshot.load(input);
    if (result.status === 'ok' && result.allWorkOrders) {
      this.compare(input, result.allWorkOrders, input.now ?? Date.now(), PROGRESS_READER.CONTEXT);
    }
    return result;
  }

  /** 守卫仍读快照镜像 + 全量指针；任一路未知且无正证据时保持未知。 */
  async readGuardBookings(
    corpId: string,
    userId: string,
  ): Promise<ActiveBookingEntry[] | undefined> {
    const [record, pointers] = await Promise.all([
      this.snapshot.peekForCandidate(corpId, userId).catch(() => null),
      this.longTerm.tryGetActiveBookings(corpId, userId, { bypassCache: true }),
    ]);
    const snapshot = record?.entries
      .filter((entry) => entry.ownedByCandidate !== false)
      .map((entry) => ({
        work_order_id: entry.workOrderId,
        linked_at: new Date(record.fetchedAt).toISOString(),
        job_id: entry.jobId,
        interview_time: entry.interviewTime ? `${entry.interviewTime}:00` : null,
      }));
    return mergeLegacyGuardBookings(snapshot, pointers ?? undefined);
  }

  /** 复聊事实视图；新鲜模式跨账号查本人手机号，缓存模式沿用既有 5 分钟快照。 */
  async read(
    scope: CandidateProgressScope,
    mode: ProgressReadMode,
  ): Promise<CandidateProgressView> {
    const [state, stage, pointers] = await Promise.all([
      this.session.getSessionState(scope.corpId, scope.userId, scope.chatId).catch(() => null),
      this.workbench.getStage(scope.corpId, scope.userId, scope.chatId).catch(() => null),
      this.longTerm.tryGetActiveBookings(scope.corpId, scope.userId, {
        bypassCache: mode === PROGRESS_READ_MODE.FRESH,
      }),
    ]);
    const rawPhone = state?.facts?.interview_info?.phone?.value;
    const sessionPhone = typeof rawPhone === 'string' ? rawPhone.trim() : '';
    const phone: CandidateProgressView['phone'] = isStorableCandidatePhone(sessionPhone)
      ? { value: sessionPhone, source: PROGRESS_PHONE_SOURCE.SESSION }
      : { value: null, source: PROGRESS_PHONE_SOURCE.MISSING };
    const names: string[] = [];
    const sessionName = state?.facts?.interview_info?.name?.value;
    if (typeof sessionName === 'string') names.push(sessionName);
    if (!phone.value && scope.botUserId) {
      const profile = await this.longTerm.getProfile(scope.corpId, scope.userId, scope.botUserId);
      const profilePhone = profile?.phone;
      if (
        isUserProfileFactValue<string>(profilePhone) &&
        isStorableCandidatePhone(profilePhone.value?.trim())
      ) {
        phone.value = profilePhone.value.trim();
        phone.source = PROGRESS_PHONE_SOURCE.PROFILE;
      }
      if (isUserProfileFactValue<string>(profile?.name)) names.push(profile.name.value);
    }
    let workOrders: SignupWorkOrderItem[] = [];
    let known = false;
    if (phone.value && scope.botImId) {
      try {
        if (mode === PROGRESS_READ_MODE.FRESH) {
          const result = await this.sponge.fetchSignupWorkOrders(
            { phone: phone.value, onlyCurrentAccount: false },
            { botImId: scope.botImId },
            { timeoutMs: 3_000, allowDefaultToken: false },
          );
          workOrders = result.workOrders ?? [];
          known = true;
        } else {
          const result = await this.loadBookingSnapshot({
            ...scope,
            botImId: scope.botImId,
            phone: phone.value,
            knownCandidateNames: names,
          });
          if (result.status === 'ok' && result.allWorkOrders) {
            workOrders = result.allWorkOrders;
            known = true;
          }
        }
      } catch {
        /* unknown：调用方决定保留旧降级行为，不把异常说成没有工单。 */
      }
    }
    const now = Date.now();
    const outOfBandVerdict = known ? evaluateOutOfBandWorkOrders(workOrders, now) : null;
    if (known) this.compare(scope, workOrders, now, PROGRESS_READER.PRE_BOOKING);
    return {
      scope,
      mode,
      policy: PROGRESS_POLICY.LEGACY,
      active: outOfBandVerdict
        ? PROGRESS_TRUTH.YES
        : known && pointers !== null
          ? PROGRESS_TRUTH.NO
          : PROGRESS_TRUTH.UNKNOWN,
      phone,
      orders: workOrders.map((order) => ({
        workOrderId: order.workOrderId,
        jobId: order.jobId ?? null,
        brandName: order.brandName ?? null,
        status: order.currentStatus ?? null,
        interviewTime: order.interviewTime ?? null,
        // The legacy snapshot omits onlyCurrentAccount; its cache key proves lookup scope, not ownership.
        ownedByCurrentAccount: PROGRESS_TRUTH.UNKNOWN,
        source:
          mode === PROGRESS_READ_MODE.CACHED
            ? PROGRESS_ORDER_SOURCE.SNAPSHOT
            : PROGRESS_ORDER_SOURCE.SPONGE_CROSS_ACCOUNT,
      })),
      workOrders,
      pointers,
      outOfBandVerdict,
      group: {
        invited: state
          ? (state.invitedGroups?.length ?? 0) > 0
            ? PROGRESS_TRUTH.YES
            : PROGRESS_TRUTH.NO
          : PROGRESS_TRUTH.UNKNOWN,
        verified: false,
      },
      stage: { value: stage?.currentStage ?? null, fallback: !stage?.currentStage },
    };
  }

  private compare(
    scope: { corpId: string; userId: string },
    orders: readonly SignupWorkOrderItem[],
    now: number,
    reader: ProgressReader,
  ): void {
    const context = orders.some((order) => isSnapshotEligibleWorkOrder(order, now));
    const proactive = Boolean(evaluateOutOfBandWorkOrders(orders, now));
    const openWithoutWindow = hasLegacyOpenWorkOrders(orders);
    if (context === proactive && context === openWithoutWindow) return;
    this.tracer?.emit({
      type: 'candidate_progress_difference',
      corpId: scope.corpId,
      userId: scope.userId,
      reader,
      selectedPolicy: PROGRESS_POLICY.LEGACY,
      context,
      proactive,
      openWithoutWindow,
      orderCount: orders.length,
    });
  }
}
