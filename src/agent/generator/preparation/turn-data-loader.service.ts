import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toErrorMessage } from '@infra/utils/error.util';
import { CallerKind } from '@/enums/agent.enum';
import { MemoryService } from '@memory/memory.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { GroupMembershipService } from '@biz/group-task/services/group-membership.service';
import type { GroupContext } from '@biz/group-task/group-task.types';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { BrandStateService, type TurnBrandContext } from '@memory/short-term/brand-state.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SpongeService } from '@sponge/sponge.service';
import { StrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import type { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { parseLocationShareCoordinates } from '@resolution/signal/markers';
import { produceTurnHints } from '@resolution/turn-hints/producers/rule-track';
import { buildVisualSheetIndex } from '@resolution/signal/self-report';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { unwrapSessionFacts } from '@memory/short-term/short-term.types';
import type { GeneratorInvokeParams } from '../generator.types';
import type {
  BookingPromptSnapshot,
  RealtimeGroupStatus,
} from '../context/sections/semantic/memory.section';
import type { GroupInventoryPromptView } from '../context/sections/working/group-inventory.section';
import type { NormalizedTurnInput } from './conversation-normalizer';
import type { TurnStartMemory } from './prompt-memory-adjudicator';
import { BookingContextLoaderService } from './booking-context-loader.service';
import {
  SnapshotEnrichmentService,
  type CandidateIdentityHint,
} from './snapshot-enrichment.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import type { TurnSourceLoadStatus, TurnSourceLoadTrace } from '@observability/observer.interface';

export interface LoadedGeoAnchor {
  longitude: number;
  latitude: number;
  city: string;
  district: string | null;
  evidence: string;
}

/** 会以 fail-open 方式自记 warning 的源；与 observeSource 的源名同名，降级判定据此自动生效。 */
const TURN_SOURCE_WARNING_SOURCES = [
  'groups',
  'group_membership',
  'account_identity',
  'brand',
  'visual_facts',
  'geocode',
] as const;

export interface TurnSourceWarning {
  source: (typeof TURN_SOURCE_WARNING_SOURCES)[number];
  message: string;
}

function isSelfWarningSource(source: string): source is TurnSourceWarning['source'] {
  return (TURN_SOURCE_WARNING_SOURCES as readonly string[]).includes(source);
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
    // 失败时要等所有兄弟源落地再发观测事件，否则先拒绝的那个源会把还在飞的源从档案里抹掉。
    const pending: Promise<unknown>[] = [];
    const observe = <T>(
      source: string,
      load: () => Promise<T> | T,
      classify?: (value: T) => TurnSourceLoadStatus | undefined,
    ): Promise<T> => {
      const promise = this.observeSource(source, load, warnings, sourceObservations, classify);
      pending.push(promise.catch(() => undefined));
      return promise;
    };
    try {
      const turnHintsPromise = observe('turn_hints', () =>
        this.detectTurnHints(input.currentTurnTexts),
      );
      const memoryPromise = turnHintsPromise.then((turnHints) =>
        observe(
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
          // 记忆域的降级不抛错也不记 warning，只在快照里挂 `_warnings`（短期窗口读失败会
          // 静默回落成「只有当前这条消息」）；不显式认领就会被当成 success 落档。
          (snapshot) => (snapshot._warnings?.length ? 'degraded' : undefined),
        ),
      );
      const pointerBookingPromise = observe('booking_pointer', () =>
        this.bookingLoader.loadPointer(params, input.currentUserMessage),
      );
      const groupsPromise = observe('groups', () => this.loadGroups(warnings));
      const realtimeGroupsPromise = groupsPromise.then((groups) =>
        observe(
          'group_membership',
          () => this.loadRealtimeGroupStatus(params, groups, warnings),
          // 上游群资源失败时本源直接短路返回 []，自己不记 warning——不认领就会落成
          // 「已核验：不在任何群」，与真正核验过的空结果无法区分。
          () => (groups === undefined ? 'degraded' : undefined),
        ),
      );

      // 依赖链直接挂在各自的前置上，不设第二道全量屏障：带外预约只等 memory + 指针，
      // 品牌只等 memory，否则它们会被最慢的无关源（逆地理编码、视觉事实）拖住。
      const bookingPromise = Promise.all([memoryPromise, pointerBookingPromise]).then(
        ([memory, pointerBooking]) =>
          observe('booking_enrichment', () =>
            this.bookingLoader.enrichOutOfBand(
              pointerBooking,
              memory,
              params,
              input.currentUserMessage,
            ),
          ),
      );
      const brandPromise = memoryPromise.then((memory) =>
        observe('brand', () => this.deriveTurnBrandContext(params.contactName, memory, warnings)),
      );

      const [
        memory,
        realtimeGroups,
        accountIdentity,
        strategyConfig,
        visualSheets,
        geo,
        booking,
        groups,
        turnBrandContext,
      ] = await Promise.all([
        memoryPromise,
        realtimeGroupsPromise,
        observe('account_identity', () => this.loadAccountIdentity(params.botImId, warnings)),
        observe('strategy', () =>
          this.strategyConfig.getActiveConfig(params.strategySource ?? 'released'),
        ),
        observe('visual_facts', () => this.loadVisualSheetIndex(params.sessionId, warnings)),
        observe('geocode', () => this.loadLocationShareAnchor(input.currentUserMessage, warnings)),
        bookingPromise,
        groupsPromise,
        brandPromise,
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
      // 先让还在飞的源落地，再发失败事件：否则档案里只有最先拒绝的那个源，
      // 排障时会把真正卡住的慢源（例如 Redis 停顿中的 memory）读成「没参与本轮」。
      await Promise.allSettled(pending);
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

  /**
   * 单个外部源的观测包装。
   *
   * 降级判定优先级：调用方显式认领（`classify`）> 本源自己记过 warning > 值形态推断。
   * 只有前两档能表达「读取失败所以为空」，值形态推断分不出空结果与失败降级。
   */
  private async observeSource<T>(
    source: string,
    load: () => Promise<T> | T,
    warnings: TurnSourceWarning[],
    observations: TurnSourceLoadTrace[],
    classify?: (value: T) => TurnSourceLoadStatus | undefined,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const value = await load();
      const selfDegraded =
        isSelfWarningSource(source) && warnings.some((warning) => warning.source === source);
      observations.push({
        source,
        status: classify?.(value) ?? (selfDegraded ? 'degraded' : classifySourceValue(value)),
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
