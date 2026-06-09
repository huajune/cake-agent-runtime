export type ConversionRange =
  | 'today'
  | 'week'
  | 'month'
  | 'twoMonths'
  | 'threeMonths'
  | 'sixMonths';

export type ConversionCohort = 'friend_added' | 'booking';
export type ConversionMetricMode = 'period' | 'cohort';

export interface ConversionFilter {
  range: ConversionRange;
  groups: string[];
  channels: string[];
  corpId?: string;
}

export interface ConversionPeriod {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
  startInstant: Date;
  endInstant: Date;
}

export interface ConversionRateMetric {
  current: number;
  previous: number;
  change: number;
  numerator: number;
  denominator: number;
}

// KPI 名片支持两种口径：
// - period：同一时段发生量快照，各阶段在当前时间窗内独立去重后按公式相除。
// - cohort：追踪本期新增好友这同一批人的后续转化，逐级分子 ⊆ 分母。
export interface ConversionKpisResponse {
  breakIceRate: ConversionRateMetric; // 破冰人数 / 新增好友
  bookingRate: ConversionRateMetric; // 报名人数 / 破冰人数
  groupInviteRate: ConversionRateMetric; // 破冰后加群人数 / 破冰人数（运营侧支，不进线性漏斗）
  passRate: ConversionRateMetric; // 面试通过人数 / 报名人数
  // 整体转化率收口到「面试通过」：= 面试通过人数 / 新增好友（不再统计入职）。
  overallRate: ConversionRateMetric;
}

export interface ConversionFunnelStage {
  stage: string;
  displayName: string;
  count: number;
  overallRate: number;
  stageRate: number;
}

export interface ConversionFunnelResponse {
  mode: ConversionMetricMode;
  cohort: ConversionCohort;
  totalCohort: number;
  stages: ConversionFunnelStage[];
}

export interface ConversionTrendCounts {
  friendAdded: number;
  breakIce: number;
  booking: number;
  interviewPass: number;
  groupInvite: number;
}

// 5 个 KPI 的逐日趋势点。口径与 KPI 名片 mode 同源。各 *Rate 为 0~1 小数；
// 当日分母为 0（无对应 cohort / 无数据）时为 null，前端渲染为断点而非 0%。其余为去重人数。
export interface ConversionTrendPoint extends ConversionTrendCounts {
  date: string; // YYYY-MM-DD
  breakIceRate: number | null; // 候选人回复 / 新增好友
  bookingRate: number | null; // 报名成功 / 候选人回复
  groupInviteRate: number | null; // 邀请进群 / 候选人回复
  passRate: number | null; // 面试通过 / 报名成功
  overallRate: number | null; // 面试通过 / 新增好友
}

export interface ConversionTrendResponse {
  mode: ConversionMetricMode;
  summary: ConversionTrendCounts;
  points: ConversionTrendPoint[];
}

export interface ConversionBotCounts {
  friends_added: number;
  break_ice: number;
  booking_success: number;
  group_invite: number;
  interview_pass: number;
  /** 自助取消工单数（booking.canceled）；运营侧支，不进线性漏斗。 */
  booking_cancel: number;
  /** 自助改约面时间数（booking.interview_modified）；运营侧支，不进线性漏斗。 */
  interview_modified: number;
}

export interface ConversionBotRow {
  botImId: string;
  managerName: string;
  groupName: string;
  eventCounts: ConversionBotCounts;
  overallRate: number;
  status: 'good' | 'warning' | 'bad';
}

export interface ConversionBotsResponse {
  bots: ConversionBotRow[];
}

export interface HandoffBucket {
  reasonCode?: string;
  displayName: string;
  count: number;
  percent: number;
}

export interface ConversionHandoffResponse {
  total: number;
  reasons: Array<HandoffBucket & { reasonCode: string }>;
}
