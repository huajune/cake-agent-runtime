import { ConversionAnalyticsService } from '@biz/conversion-analytics/conversion-analytics.service';
import { OpsEventsAnalyticsRepository } from '@biz/conversion-analytics/repositories/ops-events-analytics.repository';
import { BotGroupResolverService } from '@biz/ops-events/services/bot-group-resolver.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import type { ConversionFilter } from '@biz/conversion-analytics/types/conversion-analytics.types';
import { addLocalDays, formatLocalDate, getLocalDayStart } from '@infra/utils/date.util';

interface TestEvent {
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
  payload: Record<string, unknown> | null;
}

const today = formatLocalDate(getLocalDayStart(new Date()));
const prevDate = formatLocalDate(addLocalDays(getLocalDayStart(new Date()), -40));

const ev = (event_name: string, user_id: string, report_date: string, hour = 0): TestEvent => ({
  event_name,
  occurred_at: `${report_date}T0${hour}:00:00.000Z`, // hour 0..9：用于事件时序排序
  report_date,
  bot_im_id: null,
  manager_name: null,
  group_name: null,
  source_channel: null,
  user_id,
  chat_id: null,
  idempotency_key: null,
  payload: null,
});

const withWorkOrder = (event: TestEvent, workOrderId: string): TestEvent => ({
  ...event,
  idempotency_key: `${workOrderId}:${event.event_name}`,
  payload: { work_order_id: workOrderId },
});

const forBot = (
  event: TestEvent,
  botImId: string,
  managerName: string,
  groupName: string,
): TestEvent => ({
  ...event,
  bot_im_id: botImId,
  manager_name: managerName,
  group_name: groupName,
});

const botStageEvents = (
  botImId: string,
  managerName: string,
  groupName: string,
  prefix: string,
  eventName: string,
  count: number,
): TestEvent[] =>
  Array.from({ length: count }, (_, index) =>
    forBot(ev(eventName, `${prefix}-${index}`, today), botImId, managerName, groupName),
  );

/**
 * 用假 query-builder 模拟 ops_events 仓储：按 modifier 捕获的 event_name 与 report_date 区间过滤事件，
 * 从而真实驱动 service 的 current/previous 取数路径。
 */
function fakeOpsRepo(events: TestEvent[]): OpsEventsAnalyticsRepository {
  const findOpsEvents = jest.fn((_columns: string, modifier: (q: unknown) => unknown) => {
    let eventNames: string[] = [];
    let start: string | undefined;
    let end: string | undefined;
    const builder: Record<string, (...args: unknown[]) => unknown> = {
      gte: (col, val) => {
        if (col === 'report_date') start = val as string;
        return builder;
      },
      lte: (col, val) => {
        if (col === 'report_date') end = val as string;
        return builder;
      },
      in: (col, vals) => {
        if (col === 'event_name') eventNames = vals as string[];
        return builder;
      },
      eq: () => builder,
      order: () => builder,
    };
    modifier(builder);
    const rows = events.filter(
      (e) =>
        eventNames.includes(e.event_name) &&
        (start === undefined || e.report_date >= start) &&
        (end === undefined || e.report_date <= end),
    );
    return Promise.resolve(rows);
  });

  return {
    findOpsEvents,
    findDailyOpsReportRows: jest.fn(() => Promise.resolve([])),
  } as unknown as OpsEventsAnalyticsRepository;
}

function fakeSystemConfig(value: unknown = null): SystemConfigService {
  return {
    getConfigValue: jest.fn().mockResolvedValue(value),
  } as unknown as SystemConfigService;
}

describe('ConversionAnalyticsService — conversion analysis', () => {
  const filter: ConversionFilter = { range: 'month', groups: [], channels: [] };

  // 当前周期 cohort（友好 = friend.added）：U1..U7（U6 无 friend.added 不入 cohort）
  const currentEvents: TestEvent[] = [
    // U1：走完整链路（友好→破冰→报名→面试通过），且被加群
    ev('friend.added', 'U1', today, 0),
    ev('candidate.engaged', 'U1', today, 1),
    withWorkOrder(ev('booking.succeeded', 'U1', today, 2), 'W1'),
    // 同一候选人的第二张预约工单：period 报名仍应按人计 1，而不是按工单计 2。
    withWorkOrder(ev('booking.succeeded', 'U1', today, 3), 'W1B'),
    withWorkOrder(ev('interview.passed', 'U1', today, 4), 'W1'),
    ev('group.invited', 'U1', today, 2),
    // U2：友好→破冰→报名（无面试），被加群
    ev('friend.added', 'U2', today, 0),
    ev('candidate.engaged', 'U2', today, 1),
    withWorkOrder(ev('booking.succeeded', 'U2', today, 2), 'W2'),
    ev('group.invited', 'U2', today, 2),
    // U3：友好→破冰→加群（无报名）
    ev('friend.added', 'U3', today, 0),
    ev('candidate.engaged', 'U3', today, 1),
    ev('group.invited', 'U3', today, 2),
    // U4：仅友好
    ev('friend.added', 'U4', today, 0),
    // U5：友好→破冰（破冰事件重复两次，验证去重）
    ev('friend.added', 'U5', today, 0),
    ev('candidate.engaged', 'U5', today, 1),
    ev('candidate.engaged', 'U5', today, 2),
    // U7：友好→报名但【无破冰】→ 严格单调子集应把它从报名级剔除
    ev('friend.added', 'U7', today, 0),
    withWorkOrder(ev('booking.succeeded', 'U7', today, 2), 'W7'),
    // U6：有报名+面试但【无友好】→ 根本不在 cohort
    withWorkOrder(ev('booking.succeeded', 'U6', today, 2), 'W6'),
    withWorkOrder(ev('interview.passed', 'U6', today, 3), 'W6'),
  ];

  // 上一周期：用于校验 change(pp) 接线
  const previousEvents: TestEvent[] = [
    ev('friend.added', 'P1', prevDate, 0),
    ev('candidate.engaged', 'P1', prevDate, 1),
    ev('friend.added', 'P2', prevDate, 0),
  ];

  const buildService = () =>
    new ConversionAnalyticsService(
      fakeOpsRepo([...currentEvents, ...previousEvents]),
      new BotGroupResolverService(),
      fakeSystemConfig(),
    );

  it('KPI 按期间事件快照去重，报名不受新增好友 cohort 过滤', async () => {
    const kpis = await buildService().getKpis(filter);

    // 友好 6（U1..U5,U7）｜破冰 4（U1,U2,U3,U5，U5 去重后仍 1 人）
    expect(kpis.breakIceRate).toMatchObject({ numerator: 4, denominator: 6 });
    // 报名 KPI 是期间报名成功快照：U1,U2,U7,U6 → 4，不因 U7/U6 不在严格 cohort 链上而剔除
    expect(kpis.bookingRate).toMatchObject({ numerator: 4, denominator: 4 });
    // 面试通过 KPI 也是期间事件快照：U1,U6 → 2
    expect(kpis.passRate).toMatchObject({ numerator: 2, denominator: 4 });
    // 整体：期间面试通过 2 / 友好 6
    expect(kpis.overallRate).toMatchObject({ numerator: 2, denominator: 6 });

    expect(kpis.breakIceRate.current).toBeCloseTo(4 / 6, 4);
    expect(kpis.overallRate.current).toBeCloseTo(2 / 6, 4);
  });

  it('KPI 支持同批追踪口径：报名必须来自本期新增好友且已破冰', async () => {
    const kpis = await buildService().getKpis(filter, 'cohort');

    expect(kpis.breakIceRate).toMatchObject({ numerator: 4, denominator: 6 });
    // U7 未破冰，U6 不在新增好友 cohort，因此 cohort 报名只剩 U1/U2。
    expect(kpis.bookingRate).toMatchObject({ numerator: 2, denominator: 4 });
    expect(kpis.passRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(kpis.overallRate).toMatchObject({ numerator: 1, denominator: 6 });
    expect(kpis.groupInviteRate).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it('加群率：分母=期间破冰人数，分子为期间去重加群人数', async () => {
    const kpis = await buildService().getKpis(filter);

    // 加群 raw=U1,U2,U3 → 3；分母=破冰 4
    expect(kpis.groupInviteRate).toMatchObject({ numerator: 3, denominator: 4 });
    expect(kpis.groupInviteRate.current).toBeLessThanOrEqual(1);
  });

  it('同一时段 KPI 分母按卡片公式接线', async () => {
    const kpis = await buildService().getKpis(filter);

    expect(kpis.bookingRate.denominator).toBe(kpis.breakIceRate.numerator);
    expect(kpis.passRate.denominator).toBe(kpis.bookingRate.numerator);
    expect(kpis.overallRate.denominator).toBe(kpis.breakIceRate.denominator);
  });

  it('cohort KPI 是严格子集链路，当前比率均 ≤ 1', async () => {
    const kpis = await buildService().getKpis(filter, 'cohort');

    for (const metric of Object.values(kpis)) {
      expect(metric.current).toBeLessThanOrEqual(1);
    }
  });

  it('上一周期参与 change(pp) 计算', async () => {
    const kpis = await buildService().getKpis(filter);

    // 上一周期：友好 2（P1,P2），破冰 1（P1）→ breakIceRate.previous = 0.5
    expect(kpis.breakIceRate.previous).toBeCloseTo(0.5, 4);
    // change = (0.6667 - 0.5) * 100 ≈ 16.7pp
    expect(kpis.breakIceRate.change).toBeCloseTo(16.7, 1);
  });

  it('漏斗图保留 cohort 严格单调链路，区别于顶部 KPI 快照口径', async () => {
    const service = buildService();
    const [kpis, funnel] = await Promise.all([
      service.getKpis(filter),
      service.getFunnel('friend_added', filter),
    ]);

    const stage = (name: string) => funnel.stages.find((s) => s.stage === name)?.count;
    expect(stage('friend_added')).toBe(kpis.breakIceRate.denominator); // 6
    expect(stage('break_ice')).toBe(kpis.breakIceRate.numerator); // 4
    // 漏斗报名：raw=U1,U2,U7，∩破冰后 U7 被剔除 → 2；KPI 报名快照则是 4。
    expect(stage('booking')).toBe(2);
    expect(kpis.bookingRate.numerator).toBe(4);
    expect(stage('interview_pass')).toBe(1);
    expect(kpis.passRate.numerator).toBe(2);
  });

  it('同一时段漏斗按期间发生量展示，加群侧支不在漏斗里占一层', async () => {
    const funnel = await buildService().getFunnel('friend_added', filter, 'period');
    const stage = (name: string) => funnel.stages.find((s) => s.stage === name);

    expect(funnel.mode).toBe('period');
    expect(funnel.stages.map((s) => s.stage)).toEqual([
      'friend_added',
      'break_ice',
      'booking',
      'interview_pass',
    ]);
    expect(stage('group_invite')).toBeUndefined();
    expect(stage('friend_added')?.count).toBe(6);
    expect(stage('booking')?.count).toBe(4);
    expect(stage('booking')?.stageRate).toBeCloseTo(4 / 4, 4);
  });

  it('趋势 summary 在同一时段口径下与 KPI 分子分母对齐', async () => {
    const service = buildService();
    const [kpis, trends] = await Promise.all([
      service.getKpis(filter, 'period'),
      service.getTrends(filter, 'period'),
    ]);

    expect(trends.mode).toBe('period');
    expect(trends.summary).toMatchObject({
      friendAdded: kpis.breakIceRate.denominator,
      breakIce: kpis.breakIceRate.numerator,
      booking: kpis.bookingRate.numerator,
      interviewPass: kpis.passRate.numerator,
      groupInvite: kpis.groupInviteRate.numerator,
    });
  });

  it('趋势 summary 在同批追踪口径下与 cohort KPI 对齐', async () => {
    const service = buildService();
    const [kpis, trends] = await Promise.all([
      service.getKpis(filter, 'cohort'),
      service.getTrends(filter, 'cohort'),
    ]);

    expect(trends.mode).toBe('cohort');
    expect(trends.summary).toMatchObject({
      friendAdded: kpis.breakIceRate.denominator,
      breakIce: kpis.breakIceRate.numerator,
      booking: kpis.bookingRate.numerator,
      interviewPass: kpis.passRate.numerator,
      groupInvite: kpis.groupInviteRate.numerator,
    });
  });

  it('账号转化对比支持同一时段与同批追踪两种口径', async () => {
    const service = buildService();
    const [periodBots, cohortBots] = await Promise.all([
      service.getBots(filter, 'period'),
      service.getBots(filter, 'cohort'),
    ]);
    const period = periodBots.bots.find((row) => row.botImId === 'unknown');
    const cohort = cohortBots.bots.find((row) => row.botImId === 'unknown');

    expect(period?.eventCounts).toMatchObject({
      friends_added: 6,
      break_ice: 4,
      booking_success: 4,
      group_invite: 3,
      interview_pass: 2,
    });
    expect(cohort?.eventCounts).toMatchObject({
      friends_added: 6,
      break_ice: 4,
      booking_success: 2,
      group_invite: 3,
      interview_pass: 1,
    });
  });

  it('账号对比合并取消/改约的 period 计数（运营侧支，不进漏斗）', async () => {
    const service = new ConversionAnalyticsService(
      fakeOpsRepo([
        ev('friend.added', 'U1', today, 0),
        ev('candidate.engaged', 'U1', today, 1),
        ev('booking.canceled', 'U1', today, 2),
        ev('booking.canceled', 'U2', today, 0),
        ev('booking.interview_modified', 'U3', today, 0),
      ]),
      new BotGroupResolverService(),
      fakeSystemConfig(),
    );

    const { bots } = await service.getBots(filter, 'period');
    const row = bots.find((b) => b.botImId === 'unknown');

    expect(row?.eventCounts).toMatchObject({
      friends_added: 1,
      break_ice: 1,
      booking_cancel: 2,
      interview_modified: 1,
    });
    // 取消/改约不进 overallRate（= 面试通过 / 新增好友）。
    expect(row?.eventCounts.interview_pass).toBe(0);
  });

  it('漏斗中加群是侧支，不在漏斗里占一层，也不影响报名阶段分母', async () => {
    const funnel = await buildService().getFunnel('friend_added', filter);
    const stage = (name: string) => funnel.stages.find((s) => s.stage === name);

    expect(stage('group_invite')).toBeUndefined();
    expect(stage('booking')?.stageRate).toBeCloseTo(2 / 4, 4);
  });

  it('账号对比读取原始事件时按 bot alias 修正未分组占位值', async () => {
    const botImId = 'prod-sync:CongLingKaiShiDeXianShiShiJie';
    const service = new ConversionAnalyticsService(
      fakeOpsRepo([
        forBot(
          ev('friend.added', 'alias-user', today),
          botImId,
          'CongLingKaiShiDeXianShiShiJie',
          '未分组',
        ),
      ]),
      new BotGroupResolverService(),
      fakeSystemConfig(),
    );

    const allBots = await service.getBots(filter);
    expect(allBots.bots[0]).toMatchObject({
      managerName: 'CongLingKaiShiDeXianShiShiJie',
      groupName: '宇航组',
    });

    const yuhangBots = await service.getBots({ ...filter, groups: ['宇航组'] });
    expect(yuhangBots.bots).toHaveLength(1);
    expect(yuhangBots.bots[0].botImId).toBe(botImId);
  });

  it('账号换 bot id 后按动态身份别名配置合并为同一身份行（计数相加）', async () => {
    const events = [
      ...botStageEvents('bot-old', 'Old Manager', '测试组', 'old-friend', 'friend.added', 5),
      ...botStageEvents('bot-old', 'Old Manager', '测试组', 'old-break', 'candidate.engaged', 4),
      ...botStageEvents('bot-old', 'Old Manager', '测试组', 'old-booking', 'booking.succeeded', 1),
      ...botStageEvents('bot-old', 'Old Manager', '测试组', 'old-group', 'group.invited', 2),
      ...botStageEvents('bot-new', 'New Manager', '测试组', 'new-friend', 'friend.added', 2),
      ...botStageEvents('bot-new', 'New Manager', '测试组', 'new-break', 'candidate.engaged', 1),
      ...botStageEvents('bot-new', 'New Manager', '测试组', 'new-group', 'group.invited', 1),
    ];
    const service = new ConversionAnalyticsService(
      fakeOpsRepo(events),
      new BotGroupResolverService(),
      fakeSystemConfig({
        'bot-new': { canonicalBotImId: 'bot-old', managerName: 'Merged Manager' },
      }),
    );

    const { bots } = await service.getBots(filter);
    expect(bots.some((row) => row.botImId === 'bot-new')).toBe(false);
    const merged = bots.find((row) => row.botImId === 'bot-old');
    expect(merged?.managerName).toBe('Merged Manager');
    expect(merged?.eventCounts).toMatchObject({
      friends_added: 7,
      break_ice: 5,
      booking_success: 1,
      group_invite: 3,
      interview_pass: 0,
    });
  });

  it('期间汇总跨账号按候选人全局去重，账号明细仍保留各账号触点', async () => {
    const samePersonEvents = [
      forBot(ev('friend.added', 'shared-user', today), 'bot-a', 'A', '测试组'),
      forBot(ev('candidate.engaged', 'shared-user', today, 1), 'bot-a', 'A', '测试组'),
      forBot(ev('candidate.engaged', 'shared-user', today, 2), 'bot-b', 'B', '测试组'),
    ];
    const service = new ConversionAnalyticsService(
      fakeOpsRepo(samePersonEvents),
      new BotGroupResolverService(),
      fakeSystemConfig(),
    );

    const [kpis, { bots }] = await Promise.all([
      service.getKpis(filter, 'period'),
      service.getBots(filter, 'period'),
    ]);

    expect(kpis.breakIceRate).toMatchObject({ numerator: 1, denominator: 1 });
    expect(bots.reduce((sum, row) => sum + row.eventCounts.break_ice, 0)).toBe(2);
  });

  it('成熟同批口径排除最近批次，并保留完整观察期内的下游事件', async () => {
    const matureDate = formatLocalDate(addLocalDays(getLocalDayStart(new Date()), -7));
    const service = new ConversionAnalyticsService(
      fakeOpsRepo([
        ev('friend.added', 'mature-user', matureDate),
        ev('candidate.engaged', 'mature-user', today, 1),
        ev('friend.added', 'recent-user', today),
        ev('candidate.engaged', 'recent-user', today, 1),
      ]),
      new BotGroupResolverService(),
      fakeSystemConfig(),
    );

    const kpis = await service.getKpis({ ...filter, maturityDays: 7 }, 'cohort');

    expect(kpis.breakIceRate).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('cohort 匹配在 user_id 缺失时回退 chat_id，不漏算（§3）', async () => {
    const withChatOnly = (event: TestEvent, chatId: string): TestEvent => ({
      ...event,
      user_id: null,
      chat_id: chatId,
    });
    const events: TestEvent[] = [
      // 新增好友同时带 user_id 与 chat_id。
      { ...ev('friend.added', 'C1', today, 0), chat_id: 'CHAT1' },
      // 破冰事件只带 chat_id（user_id 缺失）→ 仍应按 chat_id 命中 cohort。
      withChatOnly(ev('candidate.engaged', 'C1', today, 1), 'CHAT1'),
    ];
    const service = new ConversionAnalyticsService(
      fakeOpsRepo(events),
      new BotGroupResolverService(),
      fakeSystemConfig(),
    );

    const kpis = await service.getKpis({ range: 'month', groups: [], channels: [] }, 'cohort');
    expect(kpis.breakIceRate).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('转人工原因读取 ops_events(handoff.triggered)，按 reason_code 聚合（§9）', async () => {
    const withReason = (event: TestEvent, reasonCode: string): TestEvent => ({
      ...event,
      payload: { reason_code: reasonCode },
    });
    const events: TestEvent[] = [
      withReason(ev('handoff.triggered', 'H1', today, 1), 'no_reception'),
      withReason(ev('handoff.triggered', 'H2', today, 1), 'no_reception'),
      withReason(ev('handoff.triggered', 'H3', today, 1), 'booking_conflict'),
    ];
    const service = new ConversionAnalyticsService(
      fakeOpsRepo(events),
      new BotGroupResolverService(),
      fakeSystemConfig(),
    );

    const handoff = await service.getHandoff({ range: 'month', groups: [], channels: [] });
    expect(handoff.total).toBe(3);
    expect(handoff.reasons[0]).toMatchObject({ reasonCode: 'no_reception', count: 2 });
    expect(handoff.reasons.find((r) => r.reasonCode === 'booking_conflict')?.count).toBe(1);
  });
});
