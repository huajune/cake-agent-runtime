import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { BotGroupResolverService } from '@biz/ops-events/services/bot-group-resolver.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  addLocalDays,
  formatLocalDate,
  getLocalDayStart,
  parseLocalDateStart,
} from '@infra/utils/date.util';
import {
  ConversionCohortStatsRow,
  ConversionHandoffReasonRow,
  ConversionPeriodStatsRow,
  ConversionStatsParams,
  OpsEventsAnalyticsRepository,
} from './repositories/ops-events-analytics.repository';
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

/** booking cohort 成员（按 身份:工单 去重）；friend_added cohort 已下沉到 RPC，不再在 Node 建模。 */
interface CohortMember {
  key: string;
  identityKey: string | null;
  workOrderId: string;
  occurredAt: number;
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
  // 「全部」按业务数据起点动态算，见 getPeriod
  all: 0,
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
  onboarding_failed: '面试通过后上岗失败或离职',
  onboarding_follow_up_required: '入职进展待人工确认',
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

/**
 * 转化分析：KPI 名片 / 漏斗 / 趋势 / 账号对比 / 转人工原因。
 *
 * 主口径（同一时段 period、同批追踪 cohort）的去重计数与 cohort 匹配全部由数据库 RPC
 * （conversion_period_stats / conversion_cohort_stats / conversion_handoff_reasons）一次往返算好，
 * 本服务只做窗口换算、小组 → bot 归属翻译、bot 名称解析补全与响应拼装。
 * 仅两条小体量侧支仍拉明细：booking cohort 漏斗、取消/改约计数。
 * RPC 失败/缺失时按空统计降级，不回退到翻页拉明细（数据库红线：降级成本单调下降）。
 */
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

    return this.buildKpisResponse(cur, prev);
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

    return this.buildKpisResponse(cur, prev);
  }

  private buildKpisResponse(
    current: ConversionTrendCounts,
    previous: ConversionTrendCounts,
  ): ConversionKpisResponse {
    return {
      breakIceRate: this.toMetric(
        current.breakIce,
        current.friendAdded,
        previous.breakIce,
        previous.friendAdded,
      ),
      bookingRate: this.toMetric(
        current.booking,
        current.breakIce,
        previous.booking,
        previous.breakIce,
      ),
      groupInviteRate: this.toMetric(
        current.groupInvite,
        current.breakIce,
        previous.groupInvite,
        previous.breakIce,
      ),
      passRate: this.toMetric(
        current.interviewPass,
        current.booking,
        previous.interviewPass,
        previous.booking,
      ),
      // 收口到面试通过：整体转化率 = 面试通过 / 新增好友（不再统计入职）。
      overallRate: this.toMetric(
        current.interviewPass,
        current.friendAdded,
        previous.interviewPass,
        previous.friendAdded,
      ),
    };
  }

  private async computePeriodCounts(
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<ConversionTrendCounts> {
    const stats = await this.fetchPeriodStats(filter, this.getDateBounds(period, scope));
    return this.periodTotal(stats);
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

    // cohort：严格单调子集的漏斗（按人去重，逐级 ⊆ 上一级）。
    // 加群是破冰后的运营侧支，不进漏斗：仅作为独立 KPI 展示，不在漏斗里占一层。
    const displayDefs = this.getStageDefs(cohort);
    const stageCounts =
      cohort === 'booking'
        ? this.countsFromStageSets(await this.computeBookingStageSets(filter, period, 'current'))
        : await this.computeFriendAddedCohortCounts(filter, period, 'current');

    const totalCohort = this.countForStage(displayDefs[0].stage, stageCounts);
    let previousCount = totalCohort;
    const stages = displayDefs.map((def, index) => {
      const count = this.countForStage(def.stage, stageCounts);
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
    const displayDefs = this.getStageDefs(cohort);
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
   * booking cohort（按 身份:工单 去重）各级去重集合（严格单调子集）：
   * 基级 = 本期报名工单；面试通过按工单号匹配且事件晚于入列，再与基级取交集。
   * 体量小（月级数百行），仍走明细；friend_added cohort 由 conversion_cohort_stats 承担。
   */
  private async computeBookingStageSets(
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<Map<string, Set<string>>> {
    const stageDefs = BOOKING_STAGE_DEFS;
    const baseEvents = await this.fetchOpsEvents(filter, period, [stageDefs[0].eventName], scope, {
      applyGroupFilter: true,
    });
    const cohortMembers = this.buildBookingCohort(baseEvents);
    const cohortKeys = new Set(cohortMembers.keys());

    const rawSets = new Map<string, Set<string>>();
    for (const def of stageDefs) rawSets.set(def.stage, new Set<string>());

    if (cohortKeys.size > 0) {
      const cohortsByIdentity = this.groupCohorts(cohortMembers, 'identityKey');
      const cohortsByWorkOrder = this.groupCohorts(cohortMembers, 'workOrderId');
      const stageByEvent = new Map(stageDefs.map((def) => [def.eventName, def.stage] as const));
      const stageEvents = await this.fetchOpsEvents(
        filter,
        period,
        stageDefs.slice(1).map((def) => def.eventName),
        scope,
        {
          applyGroupFilter: true,
          dateBounds: this.getCohortObservationBounds(period, scope, filter.maturityDays ?? 0),
        },
      );

      for (const event of stageEvents) {
        const stage = stageByEvent.get(event.event_name);
        if (!stage || stage === stageDefs[0].stage) continue;
        const occurredAt = new Date(event.occurred_at).getTime();
        for (const member of this.matchBookingCohortMembers(
          event,
          cohortsByIdentity,
          cohortsByWorkOrder,
        )) {
          if (occurredAt < member.occurredAt) continue;
          rawSets.get(stage)?.add(member.key);
        }
      }
    }

    // 严格单调子集：S[i] = rawSet[i] ∩ S[i-1]，基级 = cohort 全体。
    const result = new Map<string, Set<string>>();
    result.set(stageDefs[0].stage, cohortKeys);
    let prevSet = cohortKeys;
    for (let i = 1; i < stageDefs.length; i++) {
      const constrained = this.intersect(rawSets.get(stageDefs[i].stage), prevSet);
      result.set(stageDefs[i].stage, constrained);
      prevSet = constrained;
    }
    return result;
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
    const stats = await this.fetchPeriodStats(filter, this.getDateBounds(period, 'current'));
    const byDay = new Map(
      stats.filter((row) => row.scope === 'day' && row.bucket).map((row) => [row.bucket, row]),
    );

    const points: ConversionTrendPoint[] = this.enumerateDates(
      period.startInstant,
      period.endInstant,
    ).map((date) => this.toTrendPoint(date, this.toCounts(byDay.get(date))));

    return { mode: 'period', summary: this.periodTotal(stats), points };
  }

  /**
   * cohort 趋势：每个点 = 当天新增好友这批人的后续转化。
   * 当 maturityDays > 0 时，入列窗口整体前移，并观察到其成熟截止日。
   * RPC 已按「入列日 × bot」返回单调约束后的成员计数，逐日/总量直接求和即可。
   */
  private async getCohortTrends(filter: ConversionFilter): Promise<ConversionTrendResponse> {
    const period = this.getMetricPeriod(filter, 'cohort');
    const rows = await this.fetchCohortStats(filter, period, 'current');

    const byDay = new Map<string, ConversionCohortStatsRow[]>();
    for (const row of rows) {
      const bucket = byDay.get(row.cohort_date) ?? [];
      bucket.push(row);
      byDay.set(row.cohort_date, bucket);
    }

    const points: ConversionTrendPoint[] = this.enumerateDates(
      period.startInstant,
      period.endInstant,
    ).map((date) =>
      // 分母为 0（当日无对应 cohort / 无数据）时返回 null，前端渲染为断点而非 0%，
      // 避免「无数据日」被误读成「转化率 0%」。真实 0%（分母>0 但无转化）仍照常展示。
      this.toTrendPoint(date, this.sumCounts(byDay.get(date) ?? [])),
    );

    return { mode: 'cohort', summary: this.sumCounts(rows), points };
  }

  private async computeFriendAddedCohortCounts(
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<ConversionTrendCounts> {
    return this.sumCounts(await this.fetchCohortStats(filter, period, scope));
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

  async getBots(
    filter: ConversionFilter,
    mode: ConversionMetricMode = 'period',
  ): Promise<ConversionBotsResponse> {
    await this.botGroupResolver.warmUp();
    const period = this.getMetricPeriod(filter, mode);
    const rows =
      mode === 'cohort'
        ? await this.getBotRowsFromCohortStats(filter, period)
        : await this.getBotRowsFromPeriodStats(filter, period);

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
      this.logger.warn(`读取 bot 身份别名配置失败，跳过合并: ${toErrorMessage(error)}`);
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
    // 转人工原因读 ops_events(handoff.triggered)：与其余指标同一 report_date 切窗、
    // 同一 group_name 分组过滤口径，且与 daily_ops_report.handoff_count 同源。
    const rows = await this.fetchHandoffReasons(filter, this.getDateBounds(period, 'current'));

    const reasonCounts = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      const count = Number(row.event_count) || 0;
      reasonCounts.set(row.reason_code, (reasonCounts.get(row.reason_code) ?? 0) + count);
      total += count;
    }

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

  private async getBotRowsFromPeriodStats(
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionBotRow[]> {
    const stats = await this.fetchPeriodStats(filter, this.getDateBounds(period, 'current'));
    return stats
      .filter((row) => row.scope === 'bot')
      .map((row) => {
        const botImId = row.bot_im_id || 'unknown';
        const identity = this.resolveBotIdentity(row.bot_im_id, row.manager_name, row.group_name);
        return this.finalizeBotRow({
          ...this.createBotRow(botImId, identity.managerName, identity.groupName),
          eventCounts: this.toBotCounts(this.toCounts(row)),
        });
      });
  }

  private async getBotRowsFromCohortStats(
    filter: ConversionFilter,
    period: ConversionPeriod,
  ): Promise<ConversionBotRow[]> {
    const rows = await this.fetchCohortStats(filter, period, 'current');
    // 同一 bot 跨多个入列日：名称取最早入列成员那一行（与按事件顺序首次建行的语义一致）。
    const sorted = [...rows].sort((a, b) => a.first_occurred_at.localeCompare(b.first_occurred_at));
    const byBot = new Map<string, ConversionBotRow>();
    for (const row of sorted) {
      const botImId = row.bot_im_id || 'unknown';
      const existing = byBot.get(botImId);
      if (!existing) {
        const identity = this.resolveBotIdentity(row.bot_im_id, row.manager_name, row.group_name);
        byBot.set(botImId, {
          ...this.createBotRow(botImId, identity.managerName, identity.groupName),
          eventCounts: this.toBotCounts(this.toCounts(row)),
        });
        continue;
      }
      existing.eventCounts.friends_added += Number(row.friend_added) || 0;
      existing.eventCounts.break_ice += Number(row.break_ice) || 0;
      existing.eventCounts.booking_success += Number(row.booking) || 0;
      existing.eventCounts.group_invite += Number(row.group_invite) || 0;
      existing.eventCounts.interview_pass += Number(row.interview_pass) || 0;
    }
    return Array.from(byBot.values()).map((row) => this.finalizeBotRow(row));
  }

  // ==================== 数据源：RPC 聚合 ====================

  private fetchPeriodStats(
    filter: ConversionFilter,
    bounds: { startDate: string; endDate: string },
  ): Promise<ConversionPeriodStatsRow[]> {
    const params = this.toStatsParams(filter, bounds);
    return this.getCachedRows(this.createRowsCacheKey('conversion_period_stats', params), () =>
      this.opsEventsRepository.findPeriodStats(params),
    );
  }

  private fetchCohortStats(
    filter: ConversionFilter,
    period: ConversionPeriod,
    scope: 'current' | 'previous',
  ): Promise<ConversionCohortStatsRow[]> {
    const base = this.getDateBounds(period, scope);
    const observe = this.getCohortObservationBounds(period, scope, filter.maturityDays ?? 0);
    const params = { ...this.toStatsParams(filter, base), observeEndDate: observe.endDate };
    return this.getCachedRows(this.createRowsCacheKey('conversion_cohort_stats', params), () =>
      this.opsEventsRepository.findCohortStats(params),
    );
  }

  private fetchHandoffReasons(
    filter: ConversionFilter,
    bounds: { startDate: string; endDate: string },
  ): Promise<ConversionHandoffReasonRow[]> {
    const params = this.toStatsParams(filter, bounds);
    return this.getCachedRows(this.createRowsCacheKey('conversion_handoff_reasons', params), () =>
      this.opsEventsRepository.findHandoffReasons(params),
    );
  }

  /** 小组筛选翻译：小组名 + 解析到这些小组的 bot 归一化 key（事件 group_name 缺失时按 bot 归属）。 */
  private toStatsParams(
    filter: ConversionFilter,
    bounds: { startDate: string; endDate: string },
  ): ConversionStatsParams {
    const groups = this.normalizeListForCache(filter.groups);
    return {
      startDate: bounds.startDate,
      endDate: bounds.endDate,
      corpId: filter.corpId,
      groups,
      groupBotIds:
        groups.length > 0
          ? this.normalizeListForCache(this.botGroupResolver.listBotKeysByGroups(groups))
          : [],
    };
  }

  private periodTotal(stats: ConversionPeriodStatsRow[]): ConversionTrendCounts {
    return this.toCounts(stats.find((row) => row.scope === 'total'));
  }

  private toCounts(
    row?: Pick<
      ConversionPeriodStatsRow,
      'friend_added' | 'break_ice' | 'booking' | 'group_invite' | 'interview_pass'
    >,
  ): ConversionTrendCounts {
    return {
      friendAdded: Number(row?.friend_added) || 0,
      breakIce: Number(row?.break_ice) || 0,
      booking: Number(row?.booking) || 0,
      interviewPass: Number(row?.interview_pass) || 0,
      groupInvite: Number(row?.group_invite) || 0,
    };
  }

  private sumCounts(rows: ConversionCohortStatsRow[]): ConversionTrendCounts {
    const total: ConversionTrendCounts = {
      friendAdded: 0,
      breakIce: 0,
      booking: 0,
      interviewPass: 0,
      groupInvite: 0,
    };
    for (const row of rows) {
      const counts = this.toCounts(row);
      total.friendAdded += counts.friendAdded;
      total.breakIce += counts.breakIce;
      total.booking += counts.booking;
      total.interviewPass += counts.interviewPass;
      total.groupInvite += counts.groupInvite;
    }
    return total;
  }

  // ==================== 数据源：小体量明细侧支 ====================

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
      this.logger.warn(`转化分析行缓存加载失败 cacheKey=${cacheKey}: ${toErrorMessage(error)}`);
      throw error;
    });
    this.rowCache.set(cacheKey, { expiresAt: now + ROW_CACHE_TTL_MS, promise });
    this.pruneRowsCache(now);
    return promise;
  }

  private createRowsCacheKey(source: string, params: object): string {
    return JSON.stringify({ source, ...params });
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
    const identity = this.resolveBotIdentity(row.bot_im_id, row.manager_name, row.group_name);
    return { ...row, manager_name: identity.managerName, group_name: identity.groupName };
  }

  /** bot 名称/小组补全：事件自带值优先，缺失（或小组为「未分组」占位）时用 BotGroupResolver 解析结果。 */
  private resolveBotIdentity(
    botImId: string | null,
    rawManagerName: string | null,
    rawGroupName: string | null,
  ): { managerName: string | null; groupName: string | null } {
    const resolved = this.botGroupResolver.resolve(botImId);
    if (!resolved) return { managerName: rawManagerName, groupName: rawGroupName };
    return {
      managerName: rawManagerName || resolved.managerName,
      groupName: this.shouldUseResolvedGroup(rawGroupName) ? resolved.groupName : rawGroupName,
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
    const todayStart = getLocalDayStart(new Date());
    // 「全部」：业务表（ops_events / daily_ops_report）自 2026-01-01 起有数据，起点固定；
    // 等长的前一段必然无数据，环比由前端按覆盖标注隐藏。
    const days =
      range === 'all'
        ? Math.floor(
            (todayStart.getTime() - new Date('2026-01-01T00:00:00+08:00').getTime()) /
              (24 * 60 * 60 * 1000),
          ) + 1
        : (RANGE_DAYS[range] ?? RANGE_DAYS.week);
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
        cohort.set(cohortKey, { key: cohortKey, identityKey, workOrderId, occurredAt });
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
