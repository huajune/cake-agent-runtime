import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toErrorMessage } from '@infra/utils/error.util';
import { CallerKind } from '@/enums/agent.enum';
import { MemoryService } from '@memory/memory.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import {
  isUserProfileFactValue,
  unwrapUserProfileFactValue,
} from '@memory/long-term/long-term.types';
import type { AgentMemoryContext } from '@memory/recall.types';
import { SpongeService } from '@sponge/sponge.service';
import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  type SignupWorkOrderItem,
} from '@sponge/sponge.types';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import type { GroupContext } from '@biz/group-task/group-task.types';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { BrandStateService, type TurnBrandContext } from '@memory/short-term/brand-state.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { StrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import type { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { parseLocationShareCoordinates } from '@resolution/signal/markers';
import { produceTurnHints } from '@resolution/turn-hints/producers/rule-track';
import {
  mergeSupplementalGenderClaims,
  normalizeGenderValue,
} from '@resolution/turn-hints/producers/rule-track';
import { getTurnHintValue } from '@resolution/turn-hints/reducer';
import { buildVisualSheetIndex } from '@resolution/signal/self-report';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { unwrapSessionFacts, unwrapSessionFactValue } from '@memory/short-term/short-term.types';
import { CandidateProfileEnrichmentService } from '@biz/user/services/candidate-profile-enrichment.service';
import {
  buildJobPolicyAnalysis,
  isOfflineInterviewMethod,
} from '@tools/job-list/job-policy-parser';
import type { GeneratorInvokeParams } from '../generator.types';
import type {
  BookingLocationDetails,
  BookingPromptSnapshot,
  RealtimeGroupStatus,
} from '../context/sections/semantic/memory.section';
import {
  hasCurrentBookingInformation,
  renderBookingPrompt,
} from '../context/sections/semantic/memory.section';
import type { GroupInventoryPromptView } from '../context/sections/working/group-inventory.section';
import type { NormalizedTurnInput } from './conversation-normalizer';
import type { TurnStartMemory } from './prompt-memory-adjudicator';
import { AgentTracerService } from '@observability/agent-tracer.service';
import type { TurnSourceLoadStatus, TurnSourceLoadTrace } from '@observability/observer.interface';

export interface LoadedGeoAnchor {
  longitude: number;
  latitude: number;
  city: string;
  district: string | null;
  evidence: string;
}

export interface TurnSourceWarning {
  source: 'groups' | 'group_membership' | 'account_identity' | 'brand' | 'visual_facts' | 'geocode';
  message: string;
}

/** 本轮所有外部源的同一份快照；下游 Resolver/Sections/Tools 不再自行读取。 */
export interface TurnSourceSnapshot {
  memory: TurnStartMemory;
  booking: BookingPromptSnapshot;
  realtimeGroups: RealtimeGroupStatus[];
  groupInventory: GroupInventoryPromptView | undefined;
  accountIdentity: { nickname: string | null; gender: string | null };
  strategyConfig: StrategyConfigRecord;
  visualSheetsByContent: ReadonlyMap<string, FinalizedVisualFactSheet> | undefined;
  turnBrandContext: TurnBrandContext;
  geoAnchor: LoadedGeoAnchor | undefined;
  warnings: TurnSourceWarning[];
  sourceObservations: TurnSourceLoadTrace[];
}

type SpongeTokenContext = {
  botImId?: string;
  botUserId?: string;
  groupId?: string;
};

/** 预约源读取器；模型文案仍由 MemorySection 渲染。 */
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
      if (!renderBookingPrompt(snapshot)) return base;

      this.logger.log(
        `[prepare] 带外工单核验命中：phone 尾号${phone.slice(-4)} 在途工单 ${entries.length} 个（active_booking 指针为空）`,
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
    tokenContext?: SpongeTokenContext,
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

export interface CandidateIdentityHint {
  token?: string;
  imBotId?: string;
  imContactId?: string;
  wecomUserId?: string;
  externalUserId?: string;
}

/** 外部候选人详情只补快照空位，失败时 fail-open。 */
@Injectable()
export class SnapshotEnrichmentService {
  private readonly logger = new Logger(SnapshotEnrichmentService.name);

  constructor(private readonly candidateProfile: CandidateProfileEnrichmentService) {}

  async enrich(
    snapshot: AgentMemoryContext,
    identity: CandidateIdentityHint,
  ): Promise<AgentMemoryContext> {
    if (this.resolveKnownGender(snapshot)) return snapshot;
    try {
      const gender = await this.candidateProfile.lookupGenderFromCustomerDetail(identity);
      if (!gender) return snapshot;
      const turnHints = mergeSupplementalGenderClaims(snapshot.turnHints, gender, '客户详情接口');
      this.logger.log(`客户详情补充性别成功: gender=${gender}`);
      return { ...snapshot, turnHints };
    } catch (error) {
      this.logger.warn(`客户详情补充性别失败: ${toErrorMessage(error)}`);
      return snapshot;
    }
  }

  private resolveKnownGender(snapshot: AgentMemoryContext): '男' | '女' | null {
    return (
      normalizeGenderValue(
        unwrapUserProfileFactValue(snapshot.longTerm.semantic.profile?.gender),
      ) ??
      normalizeGenderValue(
        unwrapSessionFactValue(snapshot.shortTerm.sessionState?.facts?.interview_info.gender),
      ) ??
      normalizeGenderValue(getTurnHintValue(snapshot.turnHints, 'interview_info.gender'))
    );
  }
}

/** 每轮外部 IO 的唯一编排边界；返回结构化数据，不拼模型提示词。 */
@Injectable()
export class TurnDataLoaderService {
  private readonly logger = new Logger(TurnDataLoaderService.name);
  private readonly groupMemberLimit: number;

  constructor(
    private readonly bookingLoader: BookingContextLoaderService,
    private readonly memoryService: MemoryService,
    private readonly spongeService: SpongeService,
    private readonly groupResolver: GroupResolverService,
    private readonly groupMembership: GroupMembershipService,
    private readonly hostingMemberConfig: HostingMemberConfigService,
    private readonly brandStateService: BrandStateService,
    private readonly snapshotEnrichment: SnapshotEnrichmentService,
    private readonly chatSession: ChatSessionService,
    private readonly strategyConfig: StrategyConfigService,
    configService: ConfigService,
    @Optional() private readonly geocoding?: GeocodingService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {
    this.groupMemberLimit = parseInt(configService.get<string>('GROUP_MEMBER_LIMIT', '200'), 10);
  }

  async load(
    params: GeneratorInvokeParams,
    input: NormalizedTurnInput,
  ): Promise<TurnSourceSnapshot> {
    const startedAt = Date.now();
    const warnings: TurnSourceWarning[] = [];
    const sourceObservations: TurnSourceLoadTrace[] = [];
    try {
      const turnHintsPromise = this.observeSource(
        'turn_hints',
        () => this.detectTurnHints(input.currentTurnTexts),
        warnings,
        sourceObservations,
      );
      const memoryPromise = turnHintsPromise.then((turnHints) =>
        this.observeSource(
          'memory',
          async () => {
            const snapshot = await this.memoryService.onTurnStart(
              params.corpId,
              params.userId,
              params.sessionId,
              input.currentUserMessage,
              {
                includeShortTerm: params.callerKind === CallerKind.WECOM,
                shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
                turnHints,
                botUserId: params.botUserId,
              },
            );
            const identity = buildEnrichmentIdentity(params);
            return identity ? this.snapshotEnrichment.enrich(snapshot, identity) : snapshot;
          },
          warnings,
          sourceObservations,
        ),
      );
      const pointerBookingPromise = this.observeSource(
        'booking_pointer',
        () => this.bookingLoader.loadPointer(params, input.currentUserMessage),
        warnings,
        sourceObservations,
      );
      const groupsPromise = this.observeSource(
        'groups',
        () => this.loadGroups(warnings),
        warnings,
        sourceObservations,
        ['groups'],
      );
      const realtimeGroupsPromise = groupsPromise.then((groups) =>
        this.observeSource(
          'group_membership',
          () => this.loadRealtimeGroupStatus(params, groups, warnings),
          warnings,
          sourceObservations,
          ['group_membership'],
        ),
      );

      const [
        memory,
        pointerBooking,
        realtimeGroups,
        accountIdentity,
        strategyConfig,
        visualSheets,
        geo,
      ] = await Promise.all([
        memoryPromise,
        pointerBookingPromise,
        realtimeGroupsPromise,
        this.observeSource(
          'account_identity',
          () => this.loadAccountIdentity(params.botImId, warnings),
          warnings,
          sourceObservations,
          ['account_identity'],
        ),
        this.observeSource(
          'strategy',
          () => this.strategyConfig.getActiveConfig(params.strategySource ?? 'released'),
          warnings,
          sourceObservations,
        ),
        this.observeSource(
          'visual_facts',
          () => this.loadVisualSheetIndex(params.sessionId, warnings),
          warnings,
          sourceObservations,
          ['visual_facts'],
        ),
        this.observeSource(
          'geocode',
          () => this.loadLocationShareAnchor(input.currentUserMessage, warnings),
          warnings,
          sourceObservations,
          ['geocode'],
        ),
      ]);

      const [booking, groups, turnBrandContext] = await Promise.all([
        this.observeSource(
          'booking_enrichment',
          () =>
            this.bookingLoader.enrichOutOfBand(
              pointerBooking,
              memory,
              params,
              input.currentUserMessage,
            ),
          warnings,
          sourceObservations,
        ),
        groupsPromise,
        this.observeSource(
          'brand',
          () => this.deriveTurnBrandContext(params.contactName, memory, warnings),
          warnings,
          sourceObservations,
          ['brand'],
        ),
      ]);

      const snapshot: TurnSourceSnapshot = {
        memory,
        booking,
        realtimeGroups,
        groupInventory: buildGroupInventoryView(memory, groups, this.groupMemberLimit),
        accountIdentity,
        strategyConfig,
        visualSheetsByContent: visualSheets,
        turnBrandContext,
        geoAnchor: geo,
        warnings,
        sourceObservations: sortSourceObservations(sourceObservations),
      };
      this.emitSourceTelemetry(params.userId, 'success', startedAt, snapshot.sourceObservations);
      return snapshot;
    } catch (error) {
      this.emitSourceTelemetry(
        params.userId,
        'failure',
        startedAt,
        sortSourceObservations(sourceObservations),
        toErrorMessage(error).slice(0, 300),
      );
      throw error;
    }
  }

  private async observeSource<T>(
    source: string,
    load: () => Promise<T> | T,
    warnings: TurnSourceWarning[],
    observations: TurnSourceLoadTrace[],
    warningSources: TurnSourceWarning['source'][] = [],
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const value = await load();
      const degraded = warningSources.some((warningSource) =>
        warnings.some((warning) => warning.source === warningSource),
      );
      observations.push({
        source,
        status: degraded ? 'degraded' : classifySourceValue(value),
        durationMs: Date.now() - startedAt,
        observedAt: new Date().toISOString(),
      });
      return value;
    } catch (error) {
      observations.push({
        source,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        observedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private emitSourceTelemetry(
    userId: string,
    status: 'success' | 'failure',
    startedAt: number,
    sources: TurnSourceLoadTrace[],
    error?: string,
  ): void {
    this.tracer?.emit({
      type: 'turn_data_sources',
      userId,
      status,
      totalDurationMs: Date.now() - startedAt,
      sources,
      error,
    });
  }

  private async detectTurnHints(currentTurnTexts: string[]) {
    const texts = currentTurnTexts.map((text) => text.trim()).filter(Boolean);
    if (texts.length === 0) return null;
    const brandData = await this.spongeService.fetchBrandList();
    const facts = produceTurnHints(texts, brandData);
    if (facts) this.logger.debug(`前置规则识别命中: ${facts.reasoning}`);
    return facts;
  }

  private async loadGroups(warnings: TurnSourceWarning[]): Promise<GroupContext[] | undefined> {
    try {
      return await this.groupResolver.resolveGroups('兼职群');
    } catch (error) {
      this.recordWarning(warnings, 'groups', '兼职群资源读取失败（按未知降级）', error);
      return undefined;
    }
  }

  private async loadRealtimeGroupStatus(
    params: GeneratorInvokeParams,
    groups: GroupContext[] | undefined,
    warnings: TurnSourceWarning[],
  ): Promise<RealtimeGroupStatus[]> {
    const contactId = params.imContactId || params.userId;
    if (!contactId || params.callerKind !== CallerKind.WECOM || !groups?.length) return [];
    try {
      const idToGroup = new Map(groups.map((group) => [group.imRoomId, group]));
      const roomIds = await this.groupMembership.listUserRooms(contactId, idToGroup.keys());
      return roomIds
        .map((roomId) => idToGroup.get(roomId))
        .filter((group): group is GroupContext => Boolean(group))
        .map((group) => ({ groupName: group.groupName, city: group.city }));
    } catch (error) {
      this.recordWarning(warnings, 'group_membership', '实时群状态核验失败（按未知降级）', error);
      return [];
    }
  }

  private async loadAccountIdentity(
    botImId: string | undefined,
    warnings: TurnSourceWarning[],
  ): Promise<{ nickname: string | null; gender: string | null }> {
    try {
      return await this.hostingMemberConfig.resolveAgentAccountIdentity(botImId);
    } catch (error) {
      this.recordWarning(
        warnings,
        'account_identity',
        '账号身份配置读取失败（按未配置降级）',
        error,
      );
      return { nickname: null, gender: null };
    }
  }

  private async deriveTurnBrandContext(
    contactName: string | undefined,
    memory: TurnStartMemory,
    warnings: TurnSourceWarning[],
  ): Promise<TurnBrandContext> {
    try {
      return await this.brandStateService.deriveTurnBrandContext({
        persisted: memory.shortTerm.sessionState?.facts?.brand ?? null,
        contactName,
      });
    } catch (error) {
      this.recordWarning(warnings, 'brand', '品牌上下文派生失败（按空状态降级）', error);
      return {
        state: { currentBrand: null, excludedBrands: [] },
        persisted: false,
        nicknameBrands: [],
      };
    }
  }

  private async loadVisualSheetIndex(
    sessionId: string,
    warnings: TurnSourceWarning[],
  ): Promise<ReadonlyMap<string, FinalizedVisualFactSheet> | undefined> {
    try {
      return buildVisualSheetIndex(await this.chatSession.getVisualFacts(sessionId));
    } catch (error) {
      this.recordWarning(warnings, 'visual_facts', '视觉事实索引装配失败，回落文本兜底', error);
      return undefined;
    }
  }

  private async loadLocationShareAnchor(
    currentUserMessage: string | undefined,
    warnings: TurnSourceWarning[],
  ): Promise<LoadedGeoAnchor | undefined> {
    if (!this.geocoding || !currentUserMessage) return undefined;
    const coords = parseLocationShareCoordinates([currentUserMessage]);
    if (!coords) return undefined;
    try {
      const regeo = await this.geocoding.reverseGeocode(coords.longitude, coords.latitude);
      if (!regeo?.city?.trim()) return undefined;
      return {
        longitude: coords.longitude,
        latitude: coords.latitude,
        city: regeo.city.trim(),
        district: regeo.district?.trim() || null,
        evidence: `定位分享逆解析：${regeo.formattedAddress || `${regeo.province}${regeo.city}${regeo.district}`}`,
      };
    } catch (error) {
      this.recordWarning(warnings, 'geocode', '定位分享逆解析失败（跳过轮内锚点）', error);
      return undefined;
    }
  }

  private recordWarning(
    warnings: TurnSourceWarning[],
    source: TurnSourceWarning['source'],
    message: string,
    error: unknown,
  ): void {
    const detail = toErrorMessage(error);
    warnings.push({ source, message: `${message}: ${detail}` });
    this.logger.warn(`${message}: ${detail}`);
  }
}

function classifySourceValue(value: unknown): TurnSourceLoadStatus {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return value.length === 0 ? 'empty' : 'success';
  if (value instanceof Map || value instanceof Set) return value.size === 0 ? 'empty' : 'success';
  if (typeof value === 'object' && 'state' in value) {
    const state = (value as { state?: unknown }).state;
    if (state === 'none') return 'empty';
    if (state === 'hidden') return 'degraded';
  }
  return 'success';
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
    if (typeof candidate === 'string' && /^1\d{10}$/.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  return null;
}

function buildSpongeTokenContext(params: GeneratorInvokeParams): SpongeTokenContext | undefined {
  if (!params.botImId && !params.botUserId && !params.groupId) return undefined;
  return {
    botImId: params.botImId,
    botUserId: params.botUserId,
    groupId: params.groupId,
  };
}

function normalizeJobId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function sortSourceObservations(observations: TurnSourceLoadTrace[]): TurnSourceLoadTrace[] {
  return [...observations].sort((left, right) => left.source.localeCompare(right.source));
}

function buildEnrichmentIdentity(params: GeneratorInvokeParams): CandidateIdentityHint | undefined {
  const scenario = params.scenario ?? 'candidate-consultation';
  if (scenario !== 'candidate-consultation' || !params.token) return undefined;
  return {
    token: params.token,
    imBotId: params.botImId,
    imContactId: params.imContactId,
    wecomUserId: params.botUserId,
    externalUserId: params.externalUserId,
  };
}

/** 高置信城市门与旧实现一致；groups=undefined 表示源失败，此时不渲染空库存结论。 */
export function buildGroupInventoryView(
  memory: TurnStartMemory,
  groups: GroupContext[] | undefined,
  groupMemberLimit: number,
): GroupInventoryPromptView | undefined {
  const city = unwrapSessionFacts(memory.shortTerm.sessionState?.facts ?? null, {
    minConfidence: 'high',
  })?.preferences.city?.value?.trim();
  if (!city || !groups) return undefined;

  const normalizedTargetCity = normalizeCity(city);
  const cityGroups = groups.filter((group) => normalizeCity(group.city) === normalizedTargetCity);
  const byIndustry = new Map<string, { groupCount: number; availableCount: number }>();
  for (const group of cityGroups) {
    const industry = group.industry ?? '未分类';
    const entry = byIndustry.get(industry) ?? { groupCount: 0, availableCount: 0 };
    entry.groupCount += 1;
    if (group.memberCount === undefined || group.memberCount < groupMemberLimit) {
      entry.availableCount += 1;
    }
    byIndustry.set(industry, entry);
  }
  const industries = Array.from(byIndustry.entries())
    .sort((left, right) => right[1].groupCount - left[1].groupCount)
    .map(([industry, stats]) => ({ industry, ...stats }));
  return { city, industries };
}
