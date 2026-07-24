import { Injectable, Logger } from '@nestjs/common';
import { BotGroupResolverService } from '@biz/ops-events/services/bot-group-resolver.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  addLocalDays,
  formatLocalDate,
  getLocalDayStart,
  parseLocalDateStart,
} from '@infra/utils/date.util';
import { OpsEventsAnalyticsRepository } from './repositories/ops-events-analytics.repository';
import {
  ConversionBotCounts,
  ConversionBotRow,
  ConversionBotsResponse,
  ConversionCohort,
  ConversionFilter,
  ConversionFunnelResponse,
  ConversionKpisResponse,
  ConversionMetricMode,
  ConversionPeriod,
  ConversionRange,
  ConversionRateMetric,
  ConversionHandoffResponse,
  ConversionTrendCounts,
  ConversionTrendPoint,
  ConversionTrendResponse,
} from './types/conversion-analytics.types';

type JsonPayload = Record<string, unknown> | null;

interface OpsEventRow {
  event_name: string;
  occurred_at: string;
  report_date: string;
  bot_im_id: string | null;
  manager_name: string | null;
  group_name: string | null;
  source_channel: string | null;
  user_id: string | null;
  chat_id: string | null;
  idempotency_key: string | null;
  payload: JsonPayload;
}

interface CohortMember {
  key: string;
  identityKey: string | null;
  // userId / chatId 分开保留：friend_added cohort 的下游事件可能只带其中之一
  // （如 candidate.engaged 常缺 user_id、interview.passed 的 user/chat 来自工单可空），
  // 匹配时需要按 user_id 或 chat_id 任一命中，避免漏算（见 matchFriendAddedCohortMembers）。
  userId: string | null;
  chatId: string | null;
  workOrderId: string | null;
  occurredAt: number;
  botImId: string | null;
  managerName: string | null;
  groupName: string | null;
}

interface PeriodCountSets {
  friendAdded: Set<string>;
  breakIce: Set<string>;
  booking: Set<string>;
  interviewPass: Set<string>;
  groupInvite: Set<string>;
}

interface RowCacheEntry {
  expiresAt: number;
  promise: Promise<unknown[]>;
}

const ROW_CACHE_TTL_MS = 10_000;
const ROW_CACHE_MAX_ENTRIES = 120;

const RANGE_DAYS: Record<ConversionRange, number> = {
  today: 1,
  week: 7,
  month: 30,
  twoMonths: 60,
  threeMonths: 90,
  sixMonths: 180,
};

const OPS_EVENT_COLUMNS = [
  'event_name',
  'occurred_at',
  'report_date',
  'bot_im_id',
  'manager_name',
  'group_name',
  'source_channel',
  'user_id',
  'chat_id',
  'idempotency_key',
  'payload',
].join(',');

interface StageDef {
  stage: string;
  eventName: string;
  displayName: string;
}

// 主漏斗单调链路：好友 → 破冰 → 报名 → 面试通过（收口到面试通过，不统计入职）。
const FRIEND_ADDED_STAGE_DEFS: StageDef[] = [
  { stage: 'friend_added', eventName: 'friend.added', displayName: '新增好友' },
  { stage: 'break_ice', eventName: 'candidate.engaged', displayName: '破冰' },
  { stage: 'booking', eventName: 'booking.succeeded', displayName: '报名' },
  { stage: 'interview_pass', eventName: 'interview.passed', displayName: '面试通过' },
];

const BOOKING_STAGE_DEFS: StageDef[] = [
  { stage: 'booking', eventName: 'booking.succeeded', displayName: '报名' },
  { stage: 'interview_pass', eventName: 'interview.passed', displayName: '面试通过' },
];

// 加群是运营动作，不进线性漏斗：作为破冰后的侧支单独度量（分母=破冰人数）。
const GROUP_INVITE_EVENT = 'group.invited';
const GROUP_INVITE_STAGE = 'group_invite';

// 工单自助变更（取消 / 改约）是运营侧支动作，不进漏斗：在 bot 表里作为原始计数列单独展示。
// 直接按 period 计数 ops_events，不参与 cohort/funnel 计算，避免污染转化口径。
const BOOKING_CANCEL_EVENT = 'booking.canceled';
const INTERVIEW_MODIFIED_EVENT = 'booking.interview_modified';
const BOT_IDENTITY_ALIASES_CONFIG_KEY = 'conversion_bot_identity_aliases';
const BOT_IDENTITY_ALIASES_CACHE_TTL_MS = 60 * 1000;

interface BotIdentityAlias {
  canonicalBotImId: string;
  managerName: string | null;
}

const HANDOFF_REASON_LABELS: Record<string, string> = {
  cannot_find_store: '找不到候选人想去的门店',
  no_reception: '到店无人接待',
  booking_conflict: '预约时间冲突',
  onboarding_paperwork: '入职材料或办理问题',
  interview_result_inquiry: '候选人追问面试结果',
  modify_appointment: '改期或取消预约',
  self_recruited_or_completed: '已自招或已入职',
  no_match_or_group_full: '无匹配岗位/群满需维护',
  system_blocked: '系统异常需人工补录',
  booking_capacity_full: '岗位报名人数已满',
  group_invite_failed: '拉群失败需人工维护',
  salary_admin_inquiry: '薪资/考勤/证明类咨询',
  interview_slot_coordination: '面试时段需人工协调',
  identity_age_exception: '身份/年龄边界需人工裁量',
  other: '其他原因',
};

@Injectable()
export class ConversionAnalyticsService {
  private readonly logger = new Logger(ConversionAnalyticsService.name);
  private readonly rowCache = new Map<string, RowCacheEntry>();
  private botIdentityAliasesCache: {
    value: Record<string, BotIdentityAlias>;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly opsEventsRepository: OpsEventsAnalyticsRepository,
    private readonly botGroupResolver: BotGroupResolverService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async getKpis(
    filter: ConversionFilter,
    mode: ConversionMetricMode = 'period',
  ): Promise<ConversionKpisResponse> {
    await this.botGroupResolver.warmUp();
    const period = this.getMetricPeriod(filter, mode);
    if (mode === 'cohort') {
      return this.getCohortKpis(filter, period);
    }

    // period：同一时段发生量快照，和卡片公式一致。
    // 破冰/报名/加群/面试通过分别取本时间窗内的去重事件数，不要求同一批新增好友 cohort。
    const [cur, prev] = await Promise.all([
      this.computePeriodCounts(filter, period, 'current'),
      this.computePeriodCounts(filter, period, 'previous'),
    ]);

    return {
      breakIceRate: this.toMetric(cur.breakIce, cur.friendAdded, prev.breakIce, prev.friendAdded),
      bookingRate: this.toMetric(cur.booking, cur.breakIce, prev.booking, prev.breakIce),
      groupInviteRate: this.toMetric(
        cur.groupInvite,
        cur.breakIce,
        prev.groupInvite,
        prev.breakIce,
      ),
      passRate: this.toMetric(cur.interviewPass, cur.booking, prev.interviewPass, prev.booking),
      // 收口到面试通过：整体转化率 = 面试通过 / 新增好友（不再统计入职）。
      overallRate: this.toMetric(
        cur.interviewPass,
        cur.friendAdded,
        prev.interviewPass,
        prev.friendAdded,
      ),
    };
  }

  private async getCohortKpis(
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionKpisResponse> {
    // cohort：追踪本期新增好友这一批人，逐级保持分子属于上一级分母。
    const [cur, prev] = await Promise.all([
      this.computeFriendAddedCohortCounts(filter, period, 'current'),
      this.computeFriendAddedCohortCounts(filter, period, 'previous'),
    ]);

    return {
      breakIceRate: this.toMetric(cur.breakIce, cur.friendAdded, prev.breakIce, prev.friendAdded),
      bookingRate: this.toMetric(cur.booking, cur.breakIce, prev.booking, prev.breakIce),
      groupInviteRate: this.toMetric(
        cur.groupInvite,
        cur.breakIce,
        prev.groupInvite,
        prev.breakIce,
      ),
      passRate: this.toMetric(cur.interviewPass, cur.booking, prev.interviewPass, prev.booking),
      overallRate: this.toMetric(
        cur.interviewPass,
        cur.friendAdded,
        prev.interviewPass,
        prev.friendAdded,
      ),
    };
  }

  private async computePeriodCounts(
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<ConversionTrendCounts> {
    const events = await this.fetchOpsEvents(
      filter,
      period,
      [
        'friend.added',
        'candidate.engaged',
        'booking.succeeded',
        'group.invited',
        'interview.passed',
      ],
      scope,
      { applyGroupFilter: true },
    );

    const sets = this.createPeriodCountSets();
    for (const event of events) {
      this.addPeriodEventToSets(sets, event);
    }

    return this.toPeriodCounts(sets);
  }

  async getFunnel(
    cohort: ConversionCohort,
    filter: ConversionFilter,
    mode: ConversionMetricMode = 'cohort',
  ): Promise<ConversionFunnelResponse> {
    await this.botGroupResolver.warmUp();
    const period = this.getMetricPeriod(filter, mode);
    if (mode === 'period') {
      return this.getPeriodFunnel(cohort, filter, period);
    }

    const stageDefs = this.getStageDefs(cohort);
    // cohort：严格单调子集的漏斗（按人去重，逐级 ⊆ 上一级）。
    const stageSets = await this.computeStageSets(cohort, filter, period, 'current');

    // 加群是破冰后的运营侧支，不进漏斗：仅作为独立 KPI 展示，不在漏斗里占一层。
    const displayDefs: StageDef[] = stageDefs;

    const totalCohort = stageSets.get(displayDefs[0].stage)?.size ?? 0;
    let previousCount = totalCohort;
    const stages = displayDefs.map((def, index) => {
      const count = stageSets.get(def.stage)?.size ?? 0;
      const stageRate = index === 0 ? 1 : this.ratio(count, previousCount);
      previousCount = count;
      return {
        stage: def.stage,
        displayName: def.displayName,
        count,
        overallRate: this.ratio(count, totalCohort),
        stageRate,
      };
    });

    return { mode, cohort, totalCohort, stages };
  }

  private async getPeriodFunnel(
    cohort: ConversionCohort,
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionFunnelResponse> {
    const counts = await this.computePeriodCounts(filter, period, 'current');
    // 加群是破冰后的运营侧支，不进漏斗：仅作为独立 KPI 展示，不在漏斗里占一层。
    const displayDefs: StageDef[] =
      cohort === 'friend_added' ? FRIEND_ADDED_STAGE_DEFS : BOOKING_STAGE_DEFS;
    const totalCohort = cohort === 'booking' ? counts.booking : counts.friendAdded;
    const stages = displayDefs.map((def, index) => {
      const count = this.countForStage(def.stage, counts);
      const stageDenominator =
        index === 0 ? count : this.periodStageDenominator(def.stage, cohort, counts);
      return {
        stage: def.stage,
        displayName: def.displayName,
        count,
        overallRate: this.ratio(count, totalCohort),
        stageRate: index === 0 ? 1 : this.ratio(count, stageDenominator),
      };
    });

    return { mode: 'period', cohort, totalCohort, stages };
  }

  private getStageDefs(cohort: ConversionCohort): StageDef[] {
    return cohort === 'booking' ? BOOKING_STAGE_DEFS : FRIEND_ADDED_STAGE_DEFS;
  }

  /**
   * 计算 cohort 各级去重人数集合（严格单调子集）。
   * - 基级集合 = cohort 成员 key（friend_added 按身份去重；booking 按 身份:工单 去重）。
   * - 每个下游级：匹配 cohort 成员 + 时序检查（事件晚于成员入列），再与上一级取交集，
   *   保证分子 ⊆ 分母，所有转化率天然 ≤100%。
   * - friend_added cohort 额外产出加群侧支（group_invite）：破冰后被加群的人 ∩ 破冰集合。
   */
  private async computeStageSets(
    cohort: ConversionCohort,
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<Map<string, Set<string>>> {
    const { cohortMembers, rawSets } = await this.computeCohortRawSets(
      cohort,
      filter,
      period,
      scope,
    );
    return this.constrainStageSets(cohort, cohortMembers, rawSets);
  }

  private constrainStageSets(
    cohort: ConversionCohort,
    cohortMembers: Map<string, CohortMember>,
    rawSets: Map<string, Set<string>>,
  ): Map<string, Set<string>> {
    const stageDefs = this.getStageDefs(cohort);
    const baseStage = stageDefs[0].stage;
    const cohortKeys = new Set(cohortMembers.keys());

    // 严格单调子集：线性链上 S[i] = rawSet[i] ∩ S[i-1]，基级 = cohort 全体。
    const result = new Map<string, Set<string>>();
    result.set(baseStage, cohortKeys);
    let prevSet = cohortKeys;
    for (let i = 1; i < stageDefs.length; i++) {
      const constrained = this.intersect(rawSets.get(stageDefs[i].stage), prevSet);
      result.set(stageDefs[i].stage, constrained);
      prevSet = constrained;
    }

    // 加群侧支：与破冰集合取交集（不进线性链，分母为破冰人数）。
    if (cohort === 'friend_added') {
      const breakIceSet = result.get('break_ice');
      result.set(GROUP_INVITE_STAGE, this.intersect(rawSets.get(GROUP_INVITE_STAGE), breakIceSet));
    }

    return result;
  }

  /**
   * cohort 计算引擎：拉取基级 + 下游事件，产出 cohort 成员（含入列时刻）与各级原始命中集合
   * （rawSets：未做单调约束的「命中某级的 cohort 成员」）。computeStageSets 与
   * cohort 趋势共用此引擎，保证同批追踪口径完全一致。
   */
  private async computeCohortRawSets(
    cohort: ConversionCohort,
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<{ cohortMembers: Map<string, CohortMember>; rawSets: Map<string, Set<string>> }> {
    const stageDefs = this.getStageDefs(cohort);
    const baseStage = stageDefs[0].stage;

    // 基级与下游事件均按各自 group_name 过滤（口径与 period 一致）。
    const baseEvents = await this.fetchOpsEvents(filter, period, [stageDefs[0].eventName], scope, {
      applyGroupFilter: true,
    });
    const cohortMembers =
      cohort === 'booking'
        ? this.buildBookingCohort(baseEvents)
        : this.buildFriendAddedCohort(baseEvents);
    const cohortKeys = new Set(cohortMembers.keys());

    const includeGroupInvite = cohort === 'friend_added';
    const rawSets = new Map<string, Set<string>>();
    for (const def of stageDefs) rawSets.set(def.stage, new Set<string>());
    if (includeGroupInvite) rawSets.set(GROUP_INVITE_STAGE, new Set<string>());

    if (cohortKeys.size > 0) {
      const cohortsByIdentity = this.groupCohorts(cohortMembers, 'identityKey');
      const cohortsByWorkOrder = this.groupCohorts(cohortMembers, 'workOrderId');
      // friend_added：按 user_id / chat_id 双索引，下游事件任一命中即归属（§3）。
      const { byUser, byChat } = this.indexFriendAddedMembers(cohortMembers);
      const downstreamEventNames = stageDefs.slice(1).map((def) => def.eventName);
      const eventNames = includeGroupInvite
        ? [...downstreamEventNames, GROUP_INVITE_EVENT]
        : downstreamEventNames;

      if (eventNames.length > 0) {
        const stageByEvent = new Map(stageDefs.map((def) => [def.eventName, def.stage] as const));
        const stageEvents = await this.fetchOpsEvents(filter, period, eventNames, scope, {
          applyGroupFilter: true,
          dateBounds: this.getCohortObservationBounds(period, scope, filter.maturityDays ?? 0),
        });

        for (const event of stageEvents) {
          const stage =
            event.event_name === GROUP_INVITE_EVENT
              ? GROUP_INVITE_STAGE
              : stageByEvent.get(event.event_name);
          if (!stage || stage === baseStage) continue;

          const matchedMembers =
            cohort === 'booking'
              ? this.matchBookingCohortMembers(event, cohortsByIdentity, cohortsByWorkOrder)
              : this.matchFriendAddedCohortMembers(event, byUser, byChat);

          const occurredAt = new Date(event.occurred_at).getTime();
          for (const member of matchedMembers) {
            if (occurredAt < member.occurredAt) continue;
            rawSets.get(stage)?.add(member.key);
          }
        }
      }
    }

    return { cohortMembers, rawSets };
  }

  async getTrends(
    filter: ConversionFilter,
    mode: ConversionMetricMode = 'period',
  ): Promise<ConversionTrendResponse> {
    await this.botGroupResolver.warmUp();
    return mode === 'cohort' ? this.getCohortTrends(filter) : this.getPeriodTrends(filter);
  }

  /**
   * period 趋势：每个点 = 当天发生的各阶段去重事件数；summary = 整段时间窗去重总量。
   */
  private async getPeriodTrends(filter: ConversionFilter): Promise<ConversionTrendResponse> {
    const period = this.getPeriod(filter.range);
    const events = await this.fetchOpsEvents(
      filter,
      period,
      [
        'friend.added',
        'candidate.engaged',
        'booking.succeeded',
        'group.invited',
        'interview.passed',
      ],
      'current',
      { applyGroupFilter: true },
    );
    const summarySets = this.createPeriodCountSets();
    const buckets = new Map<string, PeriodCountSets>();

    for (const event of events) {
      this.addPeriodEventToSets(summarySets, event);
      const date = event.report_date || formatLocalDate(new Date(event.occurred_at));
      const bucket = buckets.get(date) ?? this.createPeriodCountSets();
      this.addPeriodEventToSets(bucket, event);
      buckets.set(date, bucket);
    }

    const points: ConversionTrendPoint[] = this.enumerateDates(
      period.startInstant,
      period.endInstant,
    ).map((date) => {
      const counts = this.toPeriodCounts(buckets.get(date) ?? this.createPeriodCountSets());
      return this.toTrendPoint(date, counts);
    });

    return { mode: 'period', summary: this.toPeriodCounts(summarySets), points };
  }

  /**
   * cohort 趋势：每个点 = 当天新增好友这批人的后续转化。
   * 当 maturityDays > 0 时，入列窗口整体前移，并观察到其成熟截止日。
   */
  private async getCohortTrends(filter: ConversionFilter): Promise<ConversionTrendResponse> {
    const period = this.getMetricPeriod(filter, 'cohort');
    const { cohortMembers, rawSets } = await this.computeCohortRawSets(
      'friend_added',
      filter,
      period,
      'current',
    );

    // 基级 cohort 按「新增好友当日」分桶（成员 occurredAt = 最早 friend.added 时刻）。
    const friendByDay = new Map<string, Set<string>>();
    for (const member of cohortMembers.values()) {
      const date = formatLocalDate(new Date(member.occurredAt));
      const bucket = friendByDay.get(date) ?? new Set<string>();
      bucket.add(member.key);
      friendByDay.set(date, bucket);
    }

    const breakIceRaw = rawSets.get('break_ice');
    const bookingRaw = rawSets.get('booking');
    const interviewRaw = rawSets.get('interview_pass');
    const groupInviteRaw = rawSets.get(GROUP_INVITE_STAGE);
    const summary = this.countsFromStageSets(
      this.constrainStageSets('friend_added', cohortMembers, rawSets),
    );

    const points: ConversionTrendPoint[] = this.enumerateDates(
      period.startInstant,
      period.endInstant,
    ).map((date) => {
      // 逐日单调子集：以当日新增好友这批人为分母基级，下游逐级取交集（与周期口径一致）。
      const friendSet = friendByDay.get(date) ?? new Set<string>();
      const breakIce = this.intersect(breakIceRaw, friendSet);
      const booking = this.intersect(bookingRaw, breakIce);
      const interviewPass = this.intersect(interviewRaw, booking);
      const groupInvite = this.intersect(groupInviteRaw, breakIce);

      const counts: ConversionTrendCounts = {
        friendAdded: friendSet.size,
        breakIce: breakIce.size,
        booking: booking.size,
        interviewPass: interviewPass.size,
        groupInvite: groupInvite.size,
      };
      // 分母为 0（当日无对应 cohort / 无数据）时返回 null，前端渲染为断点而非 0%，
      // 避免「无数据日」被误读成「转化率 0%」。真实 0%（分母>0 但无转化）仍照常展示。
      return this.toTrendPoint(date, counts);
    });

    return { mode: 'cohort', summary, points };
  }

  private createPeriodCountSets(): PeriodCountSets {
    return {
      friendAdded: new Set<string>(),
      breakIce: new Set<string>(),
      booking: new Set<string>(),
      interviewPass: new Set<string>(),
      groupInvite: new Set<string>(),
    };
  }

  private addPeriodEventToSets(sets: PeriodCountSets, event: OpsEventRow): void {
    switch (event.event_name) {
      case 'friend.added':
        this.addIfPresent(sets.friendAdded, this.getIdentityKey(event) ?? event.idempotency_key);
        break;
      case 'candidate.engaged':
        this.addIfPresent(sets.breakIce, this.getIdentityKey(event) ?? event.idempotency_key);
        break;
      case 'booking.succeeded':
        // 转化分析统一按候选人计数；同一人重复预约只算 1 人。
        this.addIfPresent(
          sets.booking,
          this.getIdentityKey(event) ?? this.getWorkOrderId(event) ?? event.idempotency_key,
        );
        break;
      case 'group.invited':
        this.addIfPresent(sets.groupInvite, this.getIdentityKey(event) ?? event.idempotency_key);
        break;
      case 'interview.passed':
        // 同上按「人」去重（§2）：与报名口径一致，面试通过率/整体转化率不再混用工单与人。
        this.addIfPresent(
          sets.interviewPass,
          this.getIdentityKey(event) ?? this.getWorkOrderId(event) ?? event.idempotency_key,
        );
        break;
      default:
        break;
    }
  }

  private toPeriodCounts(sets: PeriodCountSets): ConversionTrendCounts {
    return {
      friendAdded: sets.friendAdded.size,
      breakIce: sets.breakIce.size,
      booking: sets.booking.size,
      interviewPass: sets.interviewPass.size,
      groupInvite: sets.groupInvite.size,
    };
  }

  private async computeFriendAddedCohortCounts(
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<ConversionTrendCounts> {
    return this.countsFromStageSets(
      await this.computeStageSets('friend_added', filter, period, scope),
    );
  }

  private countsFromStageSets(stageSets: Map<string, Set<string>>): ConversionTrendCounts {
    return {
      friendAdded: stageSets.get('friend_added')?.size ?? 0,
      breakIce: stageSets.get('break_ice')?.size ?? 0,
      booking: stageSets.get('booking')?.size ?? 0,
      interviewPass: stageSets.get('interview_pass')?.size ?? 0,
      groupInvite: stageSets.get(GROUP_INVITE_STAGE)?.size ?? 0,
    };
  }

  private toTrendPoint(date: string, counts: ConversionTrendCounts): ConversionTrendPoint {
    return {
      date,
      ...counts,
      breakIceRate: this.rateOrNull(counts.breakIce, counts.friendAdded),
      bookingRate: this.rateOrNull(counts.booking, counts.breakIce),
      groupInviteRate: this.rateOrNull(counts.groupInvite, counts.breakIce),
      passRate: this.rateOrNull(counts.interviewPass, counts.booking),
      overallRate: this.rateOrNull(counts.interviewPass, counts.friendAdded),
    };
  }

  private countForStage(stage: string, counts: ConversionTrendCounts): number {
    switch (stage) {
      case 'friend_added':
        return counts.friendAdded;
      case 'break_ice':
        return counts.breakIce;
      case 'booking':
        return counts.booking;
      case 'interview_pass':
        return counts.interviewPass;
      case GROUP_INVITE_STAGE:
        return counts.groupInvite;
      default:
        return 0;
    }
  }

  private toBotCounts(counts: ConversionTrendCounts): ConversionBotCounts {
    return {
      friends_added: counts.friendAdded,
      break_ice: counts.breakIce,
      booking_success: counts.booking,
      group_invite: counts.groupInvite,
      interview_pass: counts.interviewPass,
      // 取消/改约不在 cohort/period 漏斗口径内，统一由 applyMutationCounts 后置合并。
      booking_cancel: 0,
      interview_modified: 0,
    };
  }

  private periodStageDenominator(
    stage: string,
    cohort: ConversionCohort,
    counts: ConversionTrendCounts,
  ): number {
    if (cohort === 'booking') return counts.booking;
    switch (stage) {
      case 'break_ice':
        return counts.friendAdded;
      case GROUP_INVITE_STAGE:
      case 'booking':
        return counts.breakIce;
      case 'interview_pass':
        return counts.booking;
      default:
        return counts.friendAdded;
    }
  }

  /** 枚举 [start, end] 之间的每个本地日（YYYY-MM-DD），含端点。366 天护栏防异常区间死循环。 */
  private enumerateDates(start: Date, end: Date): string[] {
    const dates: string[] = [];
    const last = getLocalDayStart(end).getTime();
    let cursor = getLocalDayStart(start);
    for (let i = 0; i <= 366 && cursor.getTime() <= last; i++) {
      dates.push(formatLocalDate(cursor));
      cursor = addLocalDays(cursor, 1);
    }
    return dates;
  }

  private intersect(source?: Set<string>, filterSet?: Set<string>): Set<string> {
    const out = new Set<string>();
    if (!source || !filterSet) return out;
    for (const key of source) {
      if (filterSet.has(key)) out.add(key);
    }
    return out;
  }

  private addIfPresent(target: Set<string>, value: string | null | undefined): void {
    const normalized = value?.trim();
    if (normalized) target.add(normalized);
  }

  async getBots(
    filter: ConversionFilter,
    mode: ConversionMetricMode = 'period',
  ): Promise<ConversionBotsResponse> {
    await this.botGroupResolver.warmUp();
    const period = this.getMetricPeriod(filter, mode);
    const rows =
      mode === 'cohort'
        ? await this.getBotRowsFromCohort(filter, period)
        : await this.getBotRowsFromPeriodEvents(filter, period);

    // 工单自助变更（取消/改约）按 period 直接计数 ops_events，合并到各 bot 行（不参与 cohort/漏斗）。
    const withMutations = await this.applyMutationCounts(
      rows,
      filter,
      this.getPeriod(filter.range),
    );
    const botIdentityAliases = await this.getBotIdentityAliases();

    return {
      bots: this.mergeAliasedBots(withMutations, botIdentityAliases).sort((a, b) => {
        if (b.overallRate !== a.overallRate) return b.overallRate - a.overallRate;
        return b.eventCounts.friends_added - a.eventCounts.friends_added;
      }),
    };
  }

  /**
   * 把工单自助变更计数（取消/改约）按 bot 合并进已算好的 bot 行。
   *
   * 这两个事件是运营侧支动作，不属于 cohort/漏斗口径，故无论 mode 都统一按 period 计数 ops_events，
   * 单独并入；只有取消/改约、无漏斗事件的 bot 也会补一行，避免漏计。
   */
  private async applyMutationCounts(
    rows: ConversionBotRow[],
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionBotRow[]> {
    const events = await this.fetchOpsEvents(
      filter,
      period,
      [BOOKING_CANCEL_EVENT, INTERVIEW_MODIFIED_EVENT],
      'current',
      { applyGroupFilter: true },
    );
    if (events.length === 0) return rows;

    const byBot = new Map(rows.map((row) => [row.botImId, row]));
    for (const event of events) {
      const botImId = event.bot_im_id || 'unknown';
      const row =
        byBot.get(botImId) ?? this.createBotRow(botImId, event.manager_name, event.group_name);
      if (event.event_name === BOOKING_CANCEL_EVENT) row.eventCounts.booking_cancel += 1;
      else row.eventCounts.interview_modified += 1;
      byBot.set(botImId, row);
    }
    // 补行不会改 overallRate（取消/改约不进 ratio），但仍统一 finalize 一遍保持状态字段一致。
    return Array.from(byBot.values()).map((row) => this.finalizeBotRow(row));
  }

  /**
   * 临时止血：读取 system_config.conversion_bot_identity_aliases，把换号 bot 合并到同一身份行。
   *
   * 配置形态：
   * {
   *   "newBotImId": { "canonicalBotImId": "oldOrStableBotImId", "managerName": "展示名" }
   * }
   *
   * 根治方案仍是写入侧落库稳定 wecomUserId，并改为按稳定身份聚合；这里避免真实账号映射硬编码在代码中。
   */
  private async getBotIdentityAliases(): Promise<Record<string, BotIdentityAlias>> {
    if (this.botIdentityAliasesCache && Date.now() < this.botIdentityAliasesCache.expiresAt) {
      return this.botIdentityAliasesCache.value;
    }

    try {
      const raw = await this.systemConfigService.getConfigValue<unknown>(
        BOT_IDENTITY_ALIASES_CONFIG_KEY,
      );
      const value = this.parseBotIdentityAliases(raw);
      this.botIdentityAliasesCache = {
        value,
        expiresAt: Date.now() + BOT_IDENTITY_ALIASES_CACHE_TTL_MS,
      };
      return value;
    } catch (error) {
      this.logger.warn(
        `读取 bot 身份别名配置失败，跳过合并: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  private parseBotIdentityAliases(raw: unknown): Record<string, BotIdentityAlias> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }

    const aliases: Record<string, BotIdentityAlias> = {};
    for (const [aliasBotImId, value] of Object.entries(raw as Record<string, unknown>)) {
      const aliasKey = aliasBotImId.trim();
      if (!aliasKey || !value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }

      const record = value as Record<string, unknown>;
      const canonical =
        typeof record.canonicalBotImId === 'string'
          ? record.canonicalBotImId.trim()
          : typeof record.id === 'string'
            ? record.id.trim()
            : '';
      if (!canonical) {
        continue;
      }

      const managerName =
        typeof record.managerName === 'string' && record.managerName.trim()
          ? record.managerName.trim()
          : null;
      aliases[aliasKey] = { canonicalBotImId: canonical, managerName };
    }

    return aliases;
  }

  // 临时止血：把动态配置登记的换号 bot 合并到同一身份行（计数相加）。
  // 换号前后服务的候选人基本不重叠，相加即同一人完整漏斗；个别跨换号日的会话可能微量重复，
  // 作为止血可接受。无别名登记时此函数等价于原样返回。
  private mergeAliasedBots(
    rows: ConversionBotRow[],
    aliases: Record<string, BotIdentityAlias>,
  ): ConversionBotRow[] {
    const byId = new Map<string, ConversionBotRow>();
    for (const row of rows) {
      const alias = aliases[row.botImId];
      const canonicalId = alias?.canonicalBotImId ?? row.botImId;
      const existing = byId.get(canonicalId);
      if (!existing) {
        byId.set(canonicalId, {
          ...row,
          botImId: canonicalId,
          managerName: alias?.managerName ?? row.managerName,
          eventCounts: { ...row.eventCounts },
        });
        continue;
      }
      existing.eventCounts.friends_added += row.eventCounts.friends_added;
      existing.eventCounts.break_ice += row.eventCounts.break_ice;
      existing.eventCounts.booking_success += row.eventCounts.booking_success;
      existing.eventCounts.group_invite += row.eventCounts.group_invite;
      existing.eventCounts.interview_pass += row.eventCounts.interview_pass;
      existing.eventCounts.booking_cancel += row.eventCounts.booking_cancel;
      existing.eventCounts.interview_modified += row.eventCounts.interview_modified;
      if (alias?.managerName) existing.managerName = alias.managerName;
    }
    return Array.from(byId.values()).map((row) => this.finalizeBotRow(row));
  }

  async getHandoff(filter: ConversionFilter): Promise<ConversionHandoffResponse> {
    await this.botGroupResolver.warmUp();
    const period = this.getPeriod(filter.range);
    // 转人工原因改读 ops_events(handoff.triggered)：与其余指标同一 report_date 切窗、
    // 同一 group_name 分组过滤口径，且与 daily_ops_report.handoff_count 同源——
    // 取代旧的 handoff_events.created_at 切窗 + bot_im_id 白名单（会漏算空 bot 的转人工，§9）。
    const events = await this.fetchOpsEvents(filter, period, ['handoff.triggered'], 'current', {
      applyGroupFilter: true,
    });

    const reasonCounts = new Map<string, number>();
    for (const event of events) {
      const reason = this.getHandoffReasonCode(event);
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }

    const total = events.length;
    return {
      total,
      reasons: this.toBuckets(reasonCounts, total, HANDOFF_REASON_LABELS).map((item) => ({
        reasonCode: item.key,
        displayName: item.displayName,
        count: item.count,
        percent: item.percent,
      })),
    };
  }

  private getHandoffReasonCode(event: OpsEventRow): string {
    const raw = event.payload?.reason_code;
    const code = typeof raw === 'string' ? raw.trim() : '';
    return code || 'other';
  }

  private async getBotRowsFromPeriodEvents(
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionBotRow[]> {
    const events = await this.fetchOpsEvents(
      filter,
      period,
      [
        'friend.added',
        'candidate.engaged',
        'booking.succeeded',
        'group.invited',
        'interview.passed',
      ],
      'current',
      { applyGroupFilter: true },
    );
    const byBot = new Map<string, { row: ConversionBotRow; sets: PeriodCountSets }>();

    for (const event of events) {
      const botImId = event.bot_im_id || 'unknown';
      const bucket = byBot.get(botImId) ?? {
        row: this.createBotRow(botImId, event.manager_name, event.group_name),
        sets: this.createPeriodCountSets(),
      };
      const row = bucket.row;
      this.addPeriodEventToSets(bucket.sets, event);
      row.managerName = row.managerName || event.manager_name || '未知账号';
      row.groupName = row.groupName || event.group_name || '未分组';
      byBot.set(botImId, bucket);
    }

    return Array.from(byBot.values()).map(({ row, sets }) =>
      this.finalizeBotRow({
        ...row,
        eventCounts: this.toBotCounts(this.toPeriodCounts(sets)),
      }),
    );
  }

  private async getBotRowsFromCohort(
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionBotRow[]> {
    const { cohortMembers, rawSets } = await this.computeCohortRawSets(
      'friend_added',
      filter,
      period,
      'current',
    );
    const stageSets = this.constrainStageSets('friend_added', cohortMembers, rawSets);
    const friendAdded = stageSets.get('friend_added') ?? new Set<string>();
    const breakIce = stageSets.get('break_ice') ?? new Set<string>();
    const booking = stageSets.get('booking') ?? new Set<string>();
    const groupInvite = stageSets.get(GROUP_INVITE_STAGE) ?? new Set<string>();
    const interviewPass = stageSets.get('interview_pass') ?? new Set<string>();
    const byBot = new Map<string, ConversionBotRow>();

    for (const member of cohortMembers.values()) {
      const botImId = member.botImId || 'unknown';
      const row =
        byBot.get(botImId) ?? this.createBotRow(botImId, member.managerName, member.groupName);
      row.managerName = row.managerName || member.managerName || '未知账号';
      row.groupName = row.groupName || member.groupName || '未分组';
      if (friendAdded.has(member.key)) row.eventCounts.friends_added += 1;
      if (breakIce.has(member.key)) row.eventCounts.break_ice += 1;
      if (booking.has(member.key)) row.eventCounts.booking_success += 1;
      if (groupInvite.has(member.key)) row.eventCounts.group_invite += 1;
      if (interviewPass.has(member.key)) row.eventCounts.interview_pass += 1;
      byBot.set(botImId, row);
    }

    return Array.from(byBot.values()).map((row) => this.finalizeBotRow(row));
  }

  private async fetchOpsEvents(
    filter: ConversionFilter,
    period: ConversionPeriod,
    eventNames: string[],
    scope: 'current' | 'previous',
    options: {
      applyGroupFilter: boolean;
      dateBounds?: { startDate: string; endDate: string };
    },
  ): Promise<OpsEventRow[]> {
    const { startDate, endDate } = options.dateBounds ?? this.getDateBounds(period, scope);
    const cacheKey = this.createRowsCacheKey('ops_events', {
      startDate,
      endDate,
      eventNames: this.normalizeListForCache(eventNames),
      corpId: filter.corpId,
      channels: this.normalizeListForCache(filter.channels),
      groups: options.applyGroupFilter ? this.normalizeListForCache(filter.groups) : [],
      applyGroupFilter: options.applyGroupFilter,
    });

    return this.getCachedRows(cacheKey, async () => {
      const rows = await this.opsEventsRepository.findOpsEvents<OpsEventRow>(
        OPS_EVENT_COLUMNS,
        (q) => {
          let query = q
            .gte('report_date', startDate)
            .lte('report_date', endDate)
            .in('event_name', eventNames);
          if (filter.corpId) query = query.eq('corp_id', filter.corpId);
          // source_channel 写入侧目前恒为 'unknown'（暂无渠道埋点），channels 始终为空，
          // 此过滤当前为空操作；保留以便将来接入真实渠道维度（§7）。
          if (filter.channels.length > 0) {
            query = query.in('source_channel', filter.channels);
          }
          return query.order('occurred_at', { ascending: true });
        },
      );

      const enriched = rows.map((row) => this.enrichOpsEvent(row));
      // 分组按事件自身解析出的 group_name 过滤（group_name 由 bot_im_id 经 BotGroupResolver 反范式带出）。
      // 解析不出组的根因是 bot_im_id 的同步前缀/漏登记，已在 BotGroupResolver 侧做前缀归一化 + 告警治理，
      // 不在读取侧按候选人猜组（同一候选人各事件 bot_im_id 形态一致，按人继承基本无效）。
      return options.applyGroupFilter
        ? enriched.filter((row) => this.matchesGroupFilter(row.group_name, filter))
        : enriched;
    });
  }

  private getCachedRows<T>(cacheKey: string, loadRows: () => Promise<T[]>): Promise<T[]> {
    const now = Date.now();
    const existing = this.rowCache.get(cacheKey);
    if (existing && existing.expiresAt > now) {
      return existing.promise as Promise<T[]>;
    }

    const promise: Promise<T[]> = loadRows().catch((error) => {
      const current = this.rowCache.get(cacheKey);
      if (current?.promise === promise) {
        this.rowCache.delete(cacheKey);
      }
      this.logger.warn(
        `转化分析行缓存加载失败 cacheKey=${cacheKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    });
    this.rowCache.set(cacheKey, { expiresAt: now + ROW_CACHE_TTL_MS, promise });
    this.pruneRowsCache(now);
    return promise;
  }

  private createRowsCacheKey(table: string, params: Record<string, unknown>): string {
    return JSON.stringify({ table, ...params });
  }

  private normalizeListForCache(values: string[]): string[] {
    return [...values].sort();
  }

  private pruneRowsCache(now: number): void {
    if (this.rowCache.size <= ROW_CACHE_MAX_ENTRIES) return;

    for (const [key, entry] of this.rowCache) {
      if (entry.expiresAt <= now) this.rowCache.delete(key);
    }

    while (this.rowCache.size > ROW_CACHE_MAX_ENTRIES) {
      const firstKey = this.rowCache.keys().next().value as string | undefined;
      if (!firstKey) break;
      this.rowCache.delete(firstKey);
    }
  }

  private enrichOpsEvent(row: OpsEventRow): OpsEventRow {
    const resolved = this.botGroupResolver.resolve(row.bot_im_id);
    if (!resolved) return row;
    return {
      ...row,
      manager_name: row.manager_name || resolved.managerName,
      group_name: this.shouldUseResolvedGroup(row.group_name) ? resolved.groupName : row.group_name,
    };
  }

  private shouldUseResolvedGroup(groupName: string | null | undefined): boolean {
    return !groupName || groupName === '未分组';
  }

  private matchesGroupFilter(
    groupName: string | null | undefined,
    filter: ConversionFilter,
  ): boolean {
    return filter.groups.length === 0 || (!!groupName && filter.groups.includes(groupName));
  }

  private getPeriod(range: ConversionRange): ConversionPeriod {
    const days = RANGE_DAYS[range] ?? RANGE_DAYS.week;
    const todayStart = getLocalDayStart(new Date());
    const start = addLocalDays(todayStart, -(days - 1));
    const previousStart = addLocalDays(start, -days);
    const previousEnd = addLocalDays(start, -1);

    return {
      startDate: formatLocalDate(start),
      endDate: formatLocalDate(new Date()),
      previousStartDate: formatLocalDate(previousStart),
      previousEndDate: formatLocalDate(previousEnd),
      startInstant: start,
      endInstant: new Date(),
    };
  }

  private getMetricPeriod(filter: ConversionFilter, mode: ConversionMetricMode): ConversionPeriod {
    const period = this.getPeriod(filter.range);
    const maturityDays = mode === 'cohort' ? (filter.maturityDays ?? 0) : 0;
    if (maturityDays <= 0) return period;

    return {
      startDate: formatLocalDate(addLocalDays(period.startInstant, -maturityDays)),
      endDate: formatLocalDate(addLocalDays(getLocalDayStart(period.endInstant), -maturityDays)),
      previousStartDate: formatLocalDate(
        addLocalDays(parseLocalDateStart(period.previousStartDate), -maturityDays),
      ),
      previousEndDate: formatLocalDate(
        addLocalDays(parseLocalDateStart(period.previousEndDate), -maturityDays),
      ),
      startInstant: addLocalDays(period.startInstant, -maturityDays),
      endInstant: addLocalDays(period.endInstant, -maturityDays),
    };
  }

  private getCohortObservationBounds(
    period: ConversionPeriod,
    scope: 'current' | 'previous',
    maturityDays: number,
  ): { startDate: string; endDate: string } {
    const base = this.getDateBounds(period, scope);
    return {
      startDate: base.startDate,
      endDate: formatLocalDate(addLocalDays(parseLocalDateStart(base.endDate), maturityDays)),
    };
  }

  private getDateBounds(
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): { startDate: string; endDate: string } {
    return scope === 'previous'
      ? { startDate: period.previousStartDate, endDate: period.previousEndDate }
      : { startDate: period.startDate, endDate: period.endDate };
  }

  private createBotRow(
    botImId: string,
    managerName?: string | null,
    groupName?: string | null,
  ): ConversionBotRow {
    return {
      botImId,
      managerName: managerName || '未知账号',
      groupName: groupName || '未分组',
      eventCounts: {
        friends_added: 0,
        break_ice: 0,
        booking_success: 0,
        group_invite: 0,
        interview_pass: 0,
        booking_cancel: 0,
        interview_modified: 0,
      },
      overallRate: 0,
      status: 'bad',
    };
  }

  private finalizeBotRow(row: ConversionBotRow): ConversionBotRow {
    const overallRate = this.ratio(row.eventCounts.interview_pass, row.eventCounts.friends_added);
    return {
      ...row,
      overallRate,
      status: overallRate >= 0.1 ? 'good' : overallRate >= 0.05 ? 'warning' : 'bad',
    };
  }

  private buildFriendAddedCohort(events: OpsEventRow[]): Map<string, CohortMember> {
    const cohort = new Map<string, CohortMember>();

    for (const event of events) {
      const identityKey = this.getIdentityKey(event);
      if (!identityKey) continue;

      const occurredAt = new Date(event.occurred_at).getTime();
      const existing = cohort.get(identityKey);
      if (!existing || occurredAt < existing.occurredAt) {
        cohort.set(identityKey, {
          key: identityKey,
          identityKey,
          userId: event.user_id,
          chatId: event.chat_id,
          workOrderId: null,
          occurredAt,
          botImId: event.bot_im_id,
          managerName: event.manager_name,
          groupName: event.group_name,
        });
      }
    }

    return cohort;
  }

  private buildBookingCohort(events: OpsEventRow[]): Map<string, CohortMember> {
    const cohort = new Map<string, CohortMember>();

    for (const event of events) {
      const workOrderId = this.getWorkOrderId(event);
      if (!workOrderId) continue;

      const identityKey = this.getIdentityKey(event);
      const cohortKey = `${identityKey ?? 'unknown'}:${workOrderId}`;
      const occurredAt = new Date(event.occurred_at).getTime();
      const existing = cohort.get(cohortKey);
      if (!existing || occurredAt < existing.occurredAt) {
        cohort.set(cohortKey, {
          key: cohortKey,
          identityKey,
          userId: event.user_id,
          chatId: event.chat_id,
          workOrderId,
          occurredAt,
          botImId: event.bot_im_id,
          managerName: event.manager_name,
          groupName: event.group_name,
        });
      }
    }

    return cohort;
  }

  private groupCohorts(
    members: Map<string, CohortMember>,
    field: 'identityKey' | 'workOrderId',
  ): Map<string, CohortMember[]> {
    const grouped = new Map<string, CohortMember[]>();
    for (const member of members.values()) {
      const value = member[field];
      if (!value) continue;
      const bucket = grouped.get(value) ?? [];
      bucket.push(member);
      grouped.set(value, bucket);
    }
    return grouped;
  }

  private indexFriendAddedMembers(members: Map<string, CohortMember>): {
    byUser: Map<string, CohortMember>;
    byChat: Map<string, CohortMember>;
  } {
    const byUser = new Map<string, CohortMember>();
    const byChat = new Map<string, CohortMember>();
    for (const member of members.values()) {
      if (member.userId) byUser.set(member.userId, member);
      if (member.chatId) byChat.set(member.chatId, member);
    }
    return { byUser, byChat };
  }

  private matchFriendAddedCohortMembers(
    event: OpsEventRow,
    byUser: Map<string, CohortMember>,
    byChat: Map<string, CohortMember>,
  ): CohortMember[] {
    // user_id 优先；缺失或未命中时回退 chat_id —— 下游事件（破冰/面试通过）常只带其中之一（§3）。
    const byUserHit = event.user_id ? byUser.get(event.user_id) : undefined;
    if (byUserHit) return [byUserHit];
    const byChatHit = event.chat_id ? byChat.get(event.chat_id) : undefined;
    return byChatHit ? [byChatHit] : [];
  }

  private matchBookingCohortMembers(
    event: OpsEventRow,
    cohortsByIdentity: Map<string, CohortMember[]>,
    cohortsByWorkOrder: Map<string, CohortMember[]>,
  ): CohortMember[] {
    if (event.event_name === 'interview.passed') {
      const workOrderId = this.getWorkOrderId(event);
      return workOrderId ? (cohortsByWorkOrder.get(workOrderId) ?? []) : [];
    }

    const identityKey = this.getIdentityKey(event);
    return identityKey ? (cohortsByIdentity.get(identityKey) ?? []) : [];
  }

  private getIdentityKey(event: OpsEventRow): string | null {
    return event.user_id || event.chat_id || null;
  }

  private getWorkOrderId(event: OpsEventRow): string | null {
    const payload = event.payload ?? {};
    const raw =
      payload.work_order_id ??
      payload.workOrderId ??
      payload.latest_work_order_id ??
      payload.latestWorkOrderId;
    if (raw !== undefined && raw !== null && String(raw).trim()) {
      return String(raw).trim();
    }

    const key = event.idempotency_key?.trim();
    if (!key) return null;
    const [prefix] = key.split(':');
    return prefix || null;
  }

  private toMetric(
    currentNumerator: number,
    currentDenominator: number,
    previousNumerator: number,
    previousDenominator: number,
  ): ConversionRateMetric {
    const current = this.ratio(currentNumerator, currentDenominator);
    const previous = this.ratio(previousNumerator, previousDenominator);
    return {
      current,
      previous,
      change: this.roundPp((current - previous) * 100),
      numerator: currentNumerator,
      denominator: currentDenominator,
    };
  }

  private ratio(numerator: number, denominator: number): number {
    return denominator > 0 ? this.roundRate(numerator / denominator) : 0;
  }

  /** 趋势专用：分母为 0 时返回 null（断点 / 无数据），区别于真实 0%。 */
  private rateOrNull(numerator: number, denominator: number): number | null {
    return denominator > 0 ? this.roundRate(numerator / denominator) : null;
  }

  private roundRate(value: number): number {
    return Number(value.toFixed(4));
  }

  private roundPp(value: number): number {
    return Number(value.toFixed(1));
  }

  private toBuckets(
    counts: Map<string, number>,
    total: number,
    labels: Record<string, string>,
  ): Array<{ key: string; displayName: string; count: number; percent: number }> {
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({
        key,
        displayName: labels[key] || key || '未知',
        count,
        percent: this.ratio(count, total),
      }));
  }
}
