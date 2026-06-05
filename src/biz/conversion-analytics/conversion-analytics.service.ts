import { Injectable, Logger } from '@nestjs/common';
import { BotGroupResolverService } from '@biz/ops-events/bot-group-resolver.service';
import { addLocalDays, formatLocalDate, getLocalDayStart } from '@infra/utils/date.util';
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

interface DailyOpsReportRow {
  bot_im_id: string | null;
  manager_name: string | null;
  group_name: string | null;
  friends_added_count: number | null;
  break_ice_count: number | null;
  booking_success_count: number | null;
  group_invite_count: number | null;
  interview_pass_count: number | null;
}

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

const DAILY_COLUMNS = [
  'bot_im_id',
  'manager_name',
  'group_name',
  'friends_added_count',
  'break_ice_count',
  'booking_success_count',
  'group_invite_count',
  'interview_pass_count',
].join(',');

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

const HANDOFF_REASON_LABELS: Record<string, string> = {
  cannot_find_store: '找不到候选人想去的门店',
  no_reception: '到店无人接待',
  booking_conflict: '预约时间冲突',
  onboarding_paperwork: '入职材料或办理问题',
  interview_result_inquiry: '候选人追问面试结果',
  modify_appointment: '改期或取消预约',
  self_recruited_or_completed: '已自招或已入职',
  no_match_or_group_full: '无匹配岗位/群满需维护',
  system_blocked: '工具/系统卡死',
  other: '其他原因',
};

@Injectable()
export class ConversionAnalyticsService {
  private readonly logger = new Logger(ConversionAnalyticsService.name);
  private readonly rowCache = new Map<string, RowCacheEntry>();

  constructor(
    private readonly opsEventsRepository: OpsEventsAnalyticsRepository,
    private readonly botGroupResolver: BotGroupResolverService,
  ) {}

  async getKpis(
    filter: ConversionFilter,
    mode: ConversionMetricMode = 'period',
  ): Promise<ConversionKpisResponse> {
    await this.botGroupResolver.warmUp();
    const period = this.getPeriod(filter.range);
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
    const period = this.getPeriod(filter.range);
    if (mode === 'period') {
      return this.getPeriodFunnel(cohort, filter, period);
    }

    const stageDefs = this.getStageDefs(cohort);
    // cohort：严格单调子集的漏斗（按人去重，逐级 ⊆ 上一级）。
    const stageSets = await this.computeStageSets(cohort, filter, period, 'current');

    // friend_added 漏斗额外展示「邀请进群」（破冰侧支），插在候选人回复之后。
    // 仅用于展示：计数取侧支去重人数，不进入线性链路，故不改变报名/面试阶段分母。
    const displayDefs: StageDef[] =
      cohort === 'friend_added'
        ? [
            stageDefs[0],
            stageDefs[1],
            { stage: GROUP_INVITE_STAGE, eventName: GROUP_INVITE_EVENT, displayName: '邀请进群' },
            stageDefs[2],
            stageDefs[3],
          ]
        : stageDefs;

    const totalCohort = stageSets.get(displayDefs[0].stage)?.size ?? 0;
    let previousCount = totalCohort;
    const stages = displayDefs.map((def, index) => {
      const count = stageSets.get(def.stage)?.size ?? 0;
      const stageRate = index === 0 ? 1 : this.ratio(count, previousCount);
      if (def.stage !== GROUP_INVITE_STAGE) {
        previousCount = count;
      }
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
    const displayDefs: StageDef[] =
      cohort === 'friend_added'
        ? [
            FRIEND_ADDED_STAGE_DEFS[0],
            FRIEND_ADDED_STAGE_DEFS[1],
            { stage: GROUP_INVITE_STAGE, eventName: GROUP_INVITE_EVENT, displayName: '邀请进群' },
            FRIEND_ADDED_STAGE_DEFS[2],
            FRIEND_ADDED_STAGE_DEFS[3],
          ]
        : BOOKING_STAGE_DEFS;
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
   * cohort 趋势：每个点 = 当天新增好友这批人的后续转化，仍只计入所选时间窗内发生的下游事件。
   */
  private async getCohortTrends(filter: ConversionFilter): Promise<ConversionTrendResponse> {
    const period = this.getPeriod(filter.range);
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
        // 按「预约次数（事件）」计数：与首页「预约成功数」一致——同一人报名多次计多次。
        // 每行 booking.succeeded = 一次预约，idempotency_key 唯一，直接按它去重即得预约次数。
        this.addIfPresent(sets.booking, event.idempotency_key);
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
    const period = this.getPeriod(filter.range);
    const rows =
      mode === 'cohort'
        ? await this.getBotRowsFromCohort(filter, period)
        : await this.getBotRowsFromPeriodEvents(filter, period);

    const fallbackRows =
      rows.length === 0 && mode === 'period' && filter.channels.length === 0
        ? await this.getBotRowsFromDailyReports(filter, period)
        : rows;

    return {
      bots: fallbackRows.sort((a, b) => {
        if (b.overallRate !== a.overallRate) return b.overallRate - a.overallRate;
        return b.eventCounts.friends_added - a.eventCounts.friends_added;
      }),
    };
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

  // 兜底口径（§8）：仅当 period 模式、无渠道筛选且事件查询为空时启用。
  // daily_ops_report 是「按日按 bot 的计数快照」，跨日累加不去重（同一人多日破冰会重复计），
  // 与事件级按人去重不是同一口径，数值可能偏大；仅作为无事件数据时的降级展示。
  private async getBotRowsFromDailyReports(
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionBotRow[]> {
    const rows = await this.fetchDailyRows(filter, period, 'current');
    const byBot = new Map<string, ConversionBotRow>();

    for (const row of rows) {
      const botImId = row.bot_im_id || 'unknown';
      const existing =
        byBot.get(botImId) ?? this.createBotRow(botImId, row.manager_name, row.group_name);

      existing.eventCounts.friends_added += row.friends_added_count ?? 0;
      existing.eventCounts.break_ice += row.break_ice_count ?? 0;
      existing.eventCounts.booking_success += row.booking_success_count ?? 0;
      existing.eventCounts.group_invite += row.group_invite_count ?? 0;
      existing.eventCounts.interview_pass += row.interview_pass_count ?? 0;
      existing.managerName = existing.managerName || row.manager_name || '未知账号';
      existing.groupName = existing.groupName || row.group_name || '未分组';
      byBot.set(botImId, this.finalizeBotRow(existing));
    }

    return Array.from(byBot.values()).map((row) => this.finalizeBotRow(row));
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

  private async fetchDailyRows(
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<DailyOpsReportRow[]> {
    const { startDate, endDate } = this.getDateBounds(period, scope);
    const cacheKey = this.createRowsCacheKey('daily_ops_report', {
      startDate,
      endDate,
      corpId: filter.corpId,
      groups: this.normalizeListForCache(filter.groups),
    });
    const rows = await this.getCachedRows(cacheKey, () =>
      this.opsEventsRepository.findDailyOpsReportRows<DailyOpsReportRow>(DAILY_COLUMNS, (q) => {
        let query = q.gte('report_date', startDate).lte('report_date', endDate);
        if (filter.corpId) query = query.eq('corp_id', filter.corpId);
        return query.order('report_date', { ascending: true });
      }),
    );

    return rows
      .map((row) => this.enrichDailyRow(row))
      .filter((row) => this.matchesGroupFilter(row.group_name, filter));
  }

  private async fetchOpsEvents(
    filter: ConversionFilter,
    period: ConversionPeriod,
    eventNames: string[],
    scope: 'current' | 'previous',
    options: { applyGroupFilter: boolean },
  ): Promise<OpsEventRow[]> {
    const { startDate, endDate } = this.getDateBounds(period, scope);
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

  private enrichDailyRow(row: DailyOpsReportRow): DailyOpsReportRow {
    const resolved = this.botGroupResolver.resolve(row.bot_im_id);
    if (!resolved) return row;
    return {
      ...row,
      manager_name: row.manager_name || resolved.managerName,
      group_name: this.shouldUseResolvedGroup(row.group_name) ? resolved.groupName : row.group_name,
    };
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
