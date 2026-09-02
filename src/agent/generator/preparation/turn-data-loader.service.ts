import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toErrorMessage } from '@infra/utils/error.util';
import { CallerKind } from '@/enums/agent.enum';
import { MemoryService } from '@memory/memory.service';
import { SpongeService } from '@sponge/sponge.service';
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
import { buildVisualSheetIndex } from '@resolution/signal/self-report';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { unwrapSessionFacts } from '@memory/short-term/short-term.types';
import type { GeneratorInvokeParams } from '../generator.types';
import type {
  BookingPromptSnapshot,
  RealtimeGroupStatus,
} from '../context/sections/semantic/memory.section';
import type { GroupInventoryPromptView } from '../context/sections/working/group-inventory.section';
import type { NormalizedTurnInput } from './turn-input-normalizer';
import type { TurnStartMemory } from './prompt-memory-adjudicator';
import {
  SnapshotEnrichmentService,
  type CandidateIdentityHint,
} from './snapshot-enrichment.service';
import { BookingContextLoaderService } from './booking-context-loader.service';

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
  ) {
    this.groupMemberLimit = parseInt(configService.get<string>('GROUP_MEMBER_LIMIT', '200'), 10);
  }

  async load(
    params: GeneratorInvokeParams,
    input: NormalizedTurnInput,
  ): Promise<TurnSourceSnapshot> {
    const warnings: TurnSourceWarning[] = [];
    const turnHintsPromise = this.detectTurnHints(input.currentTurnTexts);
    const memoryPromise = turnHintsPromise.then(async (turnHints) => {
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
    });
    const pointerBookingPromise = this.bookingLoader.loadPointer(params, input.currentUserMessage);
    const groupsPromise = this.loadGroups(warnings);
    const realtimeGroupsPromise = groupsPromise.then((groups) =>
      this.loadRealtimeGroupStatus(params, groups, warnings),
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
      this.loadAccountIdentity(params.botImId, warnings),
      this.strategyConfig.getActiveConfig(params.strategySource ?? 'released'),
      this.loadVisualSheetIndex(params.sessionId, warnings),
      this.loadLocationShareAnchor(input.currentUserMessage, warnings),
    ]);

    const [booking, groups, turnBrandContext] = await Promise.all([
      this.bookingLoader.enrichOutOfBand(pointerBooking, memory, params, input.currentUserMessage),
      groupsPromise,
      this.deriveTurnBrandContext(params.contactName, memory, warnings),
    ]);

    return {
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
    };
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
