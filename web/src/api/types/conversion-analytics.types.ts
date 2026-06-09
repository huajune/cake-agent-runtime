export type ConversionRange =
  | 'today'
  | 'week'
  | 'month'
  | 'twoMonths'
  | 'threeMonths'
  | 'sixMonths';

export type ConversionCohort = 'friend_added' | 'booking';
export type ConversionMetricMode = 'period' | 'cohort';

export interface ConversionQuery {
  range: ConversionRange;
  groups?: string[];
}

export interface ConversionRateMetric {
  current: number;
  previous: number;
  change: number;
  numerator: number;
  denominator: number;
}

export interface ConversionKpisResponse {
  breakIceRate: ConversionRateMetric;
  bookingRate: ConversionRateMetric;
  groupInviteRate: ConversionRateMetric;
  passRate: ConversionRateMetric;
  // 整体转化率收口到「面试通过」：= 面试通过 / 新增好友（不再统计入职）。
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

// 5 个 KPI 的逐日趋势点。各 *Rate 为 0~1 小数（与当前 mode 的名片同口径）；
// 当日分母为 0（无对应 cohort / 无数据）时为 null，渲染为断点而非 0%。其余为去重人数。
export interface ConversionTrendPoint extends ConversionTrendCounts {
  date: string; // YYYY-MM-DD
  breakIceRate: number | null;
  bookingRate: number | null;
  groupInviteRate: number | null;
  passRate: number | null;
  overallRate: number | null;
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

export interface HandoffReasonBucket {
  reasonCode: string;
  displayName: string;
  count: number;
  percent: number;
}

export interface ConversionHandoffResponse {
  total: number;
  reasons: HandoffReasonBucket[];
}
