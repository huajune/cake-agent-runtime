import { Injectable, Logger } from '@nestjs/common';
import { toErrorMessage } from '@infra/utils/error.util';
import { isUserProfileFactValue } from '@memory/long-term/long-term.types';
import { LongTermService } from '@memory/long-term/long-term.service';
import { SpongeService } from '@sponge/sponge.service';
import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  type SignupWorkOrderItem,
} from '@sponge/sponge.types';
import type { SpongeTokenResolveContext } from '@sponge/sponge-token.config';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { normalizeJobId } from '@resolution/job';
import {
  buildJobPolicyAnalysis,
  isOfflineInterviewMethod,
} from '@tools/job-list/job-policy-parser';
import type { GeneratorInvokeParams } from '../generator.types';
import type {
  BookingLocationDetails,
  BookingPromptSnapshot,
} from '../context/sections/semantic/memory.section';
import {
  hasCurrentBookingInformation,
  visibleBookingEntries,
} from '../context/sections/semantic/memory.section';
import type { TurnStartMemory } from './prompt-memory-adjudicator';

@Injectable()
export class BookingContextLoaderService {
  private readonly logger = new Logger(BookingContextLoaderService.name);

  constructor(
    private readonly longTermService: LongTermService,
    private readonly spongeService: SpongeService,
  ) {}

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

  async enrichOutOfBand(
    base: BookingPromptSnapshot,
    memory: TurnStartMemory,
    params: GeneratorInvokeParams,
    currentUserMessage: string | undefined,
  ): Promise<BookingPromptSnapshot> {
    if (hasCurrentBookingInformation(base)) return base;
    if (!requiresFreshBookingContext(currentUserMessage)) return base;
    const phone = resolveCandidatePhone(memory);
    if (!phone) return base;

    const tokenContext = buildSpongeTokenContext(params);
    try {
      const result = await this.spongeService.fetchSignupWorkOrders({ phone }, tokenContext);
      const activeOrders = (result.workOrders ?? []).filter((order: SignupWorkOrderItem) =>
        ACTIVE_INTERVIEW_WORK_ORDER_STATUSES.has(order.currentStatus?.trim() ?? ''),
      );
      if (activeOrders.length === 0) return base;

      const requiresLocationDetails = needsBookingLocationDetails(currentUserMessage);
      const entries = await Promise.all(
        activeOrders.map(async (workOrder) => {
          const jobId = normalizeJobId(workOrder.jobId);
          const location =
            requiresLocationDetails && jobId !== null
              ? await this.loadJobLocationDetails(jobId, workOrder.workOrderId, tokenContext)
              : undefined;
          return { workOrder, location };
        }),
      );
      const snapshot: BookingPromptSnapshot = {
        state: 'active',
        source: 'out_of_band',
        entries,
        syncing: false,
      };
      const visible = visibleBookingEntries(snapshot);
      if (visible.length === 0) return base;

      this.logger.log(
        `[prepare] 带外工单核验命中：phone 尾号${phone.slice(-4)} 在途工单 ${visible.length} 个（active_booking 指针为空）`,
      );
      return snapshot;
    } catch (error) {
      this.logger.warn(`带外工单核验失败（fail open 维持指针路径结果）: ${toErrorMessage(error)}`);
      return base;
    }
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
      const interviewAddress = isOfflineInterviewMethod(interviewMethod)
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

function resolveCandidatePhone(memory: TurnStartMemory): string | null {
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
