import { Injectable, Logger, Optional } from '@nestjs/common';
import { CallerKind } from '@enums/agent.enum';
import { toErrorMessage } from '@infra/utils/error.util';
import { isUserProfileFactValue } from '@memory/long-term/long-term.types';
import { LongTermService } from '@memory/long-term/long-term.service';
import { PhoneSessionIndexService } from '@memory/phone-session-index.service';
import { SpongeService } from '@sponge/sponge.service';
import type { SignupWorkOrderItem } from '@sponge/sponge.types';
import type { SpongeTokenResolveContext } from '@sponge/sponge-token.config';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { normalizeJobId } from '@resolution/job';
import { requiresStoreVisit } from '@sponge/interview-method';
import { buildJobPolicyAnalysis } from '@tools/job-list/job-policy-parser';
import { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import type { BookingSnapshotEntry } from '@tools/booking/booking-snapshot.types';
import { BOOKING_DEDUP_WINDOW_MS } from '@tools/booking/active-booking-dedup.util';
import type { GeneratorInvokeParams } from '../generator.types';
import type {
  BookingLocationDetails,
  BookingPromptEntry,
  BookingPromptSnapshot,
} from '../context/sections/semantic/memory.section';
import type { TurnStartMemory } from './prompt-memory-adjudicator';

/**
 * 每轮预约读视图的装配：快照优先（按本人手机号从海绵查一次，替代逐工单号查 N 次），
 * 快照查询失败/账号没配 token/没有本人手机号时回落 active_booking 指针路径。
 *
 * 只读、不落库；副作用（排提醒、终态、事件）在渠道层的 OobReconcileService，不在这里。
 */
@Injectable()
export class BookingContextLoaderService {
  private readonly logger = new Logger(BookingContextLoaderService.name);

  constructor(
    private readonly longTermService: LongTermService,
    private readonly spongeService: SpongeService,
    @Optional() private readonly bookingSnapshot?: BookingSnapshotService,
    @Optional() private readonly phoneSessionIndex?: PhoneSessionIndexService,
  ) {}

  /** 本轮预约读视图入口。 */
  async load(
    memory: TurnStartMemory,
    params: GeneratorInvokeParams,
    currentUserMessage: string | undefined,
  ): Promise<BookingPromptSnapshot> {
    const phone = resolveCandidatePhone(memory);
    // 手机号→会话索引是带外补偿扫描的反查依据，只能由企微生产回合刷新：回归测试/调试链路
    // 也走 prepare，写进去会让扫描把真实工单的提醒排到测试会话上。
    if (phone && params.callerKind === CallerKind.WECOM) this.refreshPhoneIndex(phone, params);
    if (!phone || !this.bookingSnapshot) {
      return this.loadPointer(params, currentUserMessage);
    }

    const result = await this.bookingSnapshot.load({
      phone,
      botImId: params.botImId,
      corpId: params.corpId,
      userId: params.userId,
      knownCandidateNames: resolveKnownCandidateNames(memory),
      bypassCache: requiresFreshBookingContext(currentUserMessage),
    });
    if (result.status !== 'ok') {
      return this.loadPointer(params, currentUserMessage);
    }

    const tokenContext = buildSpongeTokenContext(params);
    const requiresLocationDetails = needsBookingLocationDetails(currentUserMessage);
    const entries: BookingPromptEntry[] = await Promise.all(
      result.entries.map(async (entry) => ({
        workOrder: entry.workOrder,
        signupSource: entry.signupSource,
        ownedByCandidate: entry.ownedByCandidate,
        location:
          requiresLocationDetails && entry.jobId !== null
            ? await this.loadJobLocationDetails(entry.jobId, entry.workOrderId, tokenContext)
            : undefined,
      })),
    );
    const concurrent = await this.loadConcurrentPointerEntries(
      params,
      result.entries,
      tokenContext,
    );
    const merged = [...entries, ...concurrent];
    if (merged.length === 0) return { state: 'none' };
    return { state: 'active', source: 'snapshot', entries: merged, syncing: false };
  }

  /**
   * active_booking 指针路径（快照不可用时的兜底；短期保留，观察后退役）。
   */
  async loadPointer(
    params: GeneratorInvokeParams,
    currentUserMessage: string | undefined,
  ): Promise<BookingPromptSnapshot> {
    const tokenContext = buildSpongeTokenContext(params);
    try {
      const activeBookings = await this.longTermService.getActiveBookings(
        params.corpId,
        params.userId,
      );
      if (activeBookings.length === 0) return { state: 'none' };

      const requiresFreshLookup = requiresFreshBookingContext(currentUserMessage);
      const requiresLocationDetails = needsBookingLocationDetails(currentUserMessage);
      const lookups = await Promise.all(
        activeBookings.map(async ({ work_order_id: workOrderId }) => {
          try {
            const workOrder = requiresFreshLookup
              ? await this.spongeService.getWorkOrderById(workOrderId, tokenContext, {
                  throwOnFetchError: true,
                })
              : await this.spongeService.getCachedWorkOrderById(workOrderId, tokenContext);
            const jobId = normalizeJobId(workOrder?.jobId);
            const location =
              requiresLocationDetails && jobId !== null
                ? await this.loadJobLocationDetails(jobId, workOrderId, tokenContext)
                : undefined;
            return { workOrderId, workOrder, location, fetchFailed: false };
          } catch (error) {
            this.logger.warn(
              `加载单个预约工单上下文失败 workOrderId=${workOrderId}: ${toErrorMessage(error)}`,
            );
            return { workOrderId, workOrder: null, location: undefined, fetchFailed: true };
          }
        }),
      );

      const entries = lookups
        .filter((lookup): lookup is typeof lookup & { workOrder: SignupWorkOrderItem } =>
          Boolean(lookup.workOrder),
        )
        .map(({ workOrder, location }) => ({ workOrder, location }));

      for (const lookup of lookups) {
        if (!lookup.fetchFailed && !lookup.workOrder) {
          this.logger.warn(
            `active_booking 指向的工单海绵查不到（指针可能已失效，按无此预约跳过）workOrderId=${lookup.workOrderId}`,
          );
        }
      }

      return {
        state: 'active',
        source: 'active_booking',
        entries,
        syncing: requiresFreshLookup && lookups.some((lookup) => lookup.fetchFailed),
      };
    } catch (error) {
      this.logger.warn(`加载预约上下文失败: ${toErrorMessage(error)}`);
      return { state: 'hidden' };
    }
  }

  /**
   * 「另一账号刚建单」的并发场景：active_booking 是候选人级指针，跨托管账号共享；本账号
   * 的手机号快照查不到别家账号的工单，只有 30 分钟窗口内的指针能把它带出来。窗口外的
   * 指针不再补查——快照才是本账号的权威读视图。
   */
  private async loadConcurrentPointerEntries(
    params: GeneratorInvokeParams,
    snapshotEntries: readonly BookingSnapshotEntry[],
    tokenContext: SpongeTokenResolveContext | undefined,
  ): Promise<BookingPromptEntry[]> {
    const known = new Set(snapshotEntries.map((entry) => entry.workOrderId));
    let pointers: Array<{ work_order_id: number; linked_at: string }>;
    try {
      pointers = await this.longTermService.getActiveBookings(params.corpId, params.userId);
    } catch (error) {
      this.logger.warn(`读取 active_booking 指针失败（快照不受影响）: ${toErrorMessage(error)}`);
      return [];
    }
    const now = Date.now();
    const recent = pointers.filter((pointer) => {
      if (known.has(pointer.work_order_id)) return false;
      const linkedAt = Date.parse(pointer.linked_at);
      return Number.isFinite(linkedAt) && now - linkedAt < BOOKING_DEDUP_WINDOW_MS;
    });
    if (recent.length === 0) return [];
    const lookups = await Promise.all(
      recent.map(async ({ work_order_id: workOrderId }): Promise<BookingPromptEntry | null> => {
        try {
          const workOrder = await this.spongeService.getCachedWorkOrderById(
            workOrderId,
            tokenContext,
          );
          return workOrder ? { workOrder, ownedByCandidate: true } : null;
        } catch (error) {
          this.logger.warn(
            `并发窗口内指针工单补查失败 workOrderId=${workOrderId}: ${toErrorMessage(error)}`,
          );
          return null;
        }
      }),
    );
    return lookups.filter((entry): entry is BookingPromptEntry => entry !== null);
  }

  private refreshPhoneIndex(phone: string, params: GeneratorInvokeParams): void {
    if (!this.phoneSessionIndex || !params.corpId || !params.userId || !params.sessionId) return;
    void this.phoneSessionIndex.record(phone, {
      corpId: params.corpId,
      userId: params.userId,
      chatId: params.sessionId,
      botImId: params.botImId ?? null,
    });
  }

  private async loadJobLocationDetails(
    jobId: number,
    workOrderId: number,
    tokenContext?: SpongeTokenResolveContext,
  ): Promise<BookingLocationDetails | undefined> {
    try {
      const detail = await this.spongeService.fetchJobs(
        {
          jobIdList: [jobId],
          pageNum: 1,
          pageSize: 1,
          onlySignableJobs: false,
          options: { includeBasicInfo: true, includeInterviewProcess: true },
        },
        tokenContext,
      );
      const job = detail.jobs[0];
      if (!job) return undefined;
      const storeAddress =
        typeof job.basicInfo?.storeInfo?.storeAddress === 'string'
          ? job.basicInfo.storeInfo.storeAddress.trim()
          : undefined;
      const interviewMeta = buildJobPolicyAnalysis(job).interviewMeta;
      const interviewMethod = interviewMeta.method ?? undefined;
      const interviewAddress = requiresStoreVisit(interviewMeta.method)
        ? (interviewMeta.address ?? undefined)
        : undefined;
      return { storeAddress, interviewMethod, interviewAddress };
    } catch (error) {
      this.logger.warn(`加载预约地址详情失败 workOrderId=${workOrderId}: ${toErrorMessage(error)}`);
      return undefined;
    }
  }
}

export function requiresFreshBookingContext(currentUserMessage: string | undefined): boolean {
  if (!currentUserMessage) return false;
  return /面试|预约|报名|改约|改期|改到|换(?:个|一)?时间|取消|不去|去不了|来不了|推迟|延期|迟到|到店|报到|入职|地址|位置|定位|导航|怎么走|找不到|搞错/u.test(
    currentUserMessage,
  );
}

function needsBookingLocationDetails(currentUserMessage: string | undefined): boolean {
  return Boolean(
    currentUserMessage &&
      /面试|到店|报到|地址|位置|定位|导航|怎么走|找不到|搞错/u.test(currentUserMessage),
  );
}

export function resolveCandidatePhone(memory: TurnStartMemory): string | null {
  const sessionPhone = memory.shortTerm.sessionState?.facts?.interview_info?.phone?.value;
  const profileFact = memory.longTerm.semantic.profile?.phone;
  const profilePhone = isUserProfileFactValue(profileFact) ? profileFact.value : undefined;
  for (const candidate of [sessionPhone, profilePhone]) {
    // 号段判据只认 @resolution/candidate/phone 的唯一权威式；本地再写一条 /^1\d{10}$/
    // 会放行 10x/11x/12x 这类系统别处根本不会入库的脏号，白跑一次海绵查询。
    const normalized = typeof candidate === 'string' ? candidate.trim() : '';
    if (isStorableCandidatePhone(normalized)) return normalized;
  }
  return null;
}

/** 本人校验的已知姓名：会话事实与长期档案（任一命中即本人）。 */
export function resolveKnownCandidateNames(memory: TurnStartMemory): string[] {
  const sessionName = memory.shortTerm.sessionState?.facts?.interview_info?.name?.value;
  const profileFact = memory.longTerm.semantic.profile?.name;
  const profileName = isUserProfileFactValue(profileFact) ? profileFact.value : undefined;
  return [sessionName, profileName].filter(
    (name): name is string => typeof name === 'string' && name.trim().length > 0,
  );
}

function buildSpongeTokenContext(
  params: GeneratorInvokeParams,
): SpongeTokenResolveContext | undefined {
  if (!params.botImId && !params.botUserId && !params.groupId) return undefined;
  return {
    botImId: params.botImId,
    botUserId: params.botUserId,
    groupId: params.groupId,
  };
}
