import type {
  ConversionKpisResponse,
  ConversionRange,
} from '@/api/types/conversion-analytics.types';
import type { AnalyticsRangeOption } from '@/components/AnalyticsControlFilters';
import { THEME_COLORS } from '@/constants';

export const TIME_RANGE_OPTIONS: Array<AnalyticsRangeOption<ConversionRange>> = [
  { key: 'today', label: '本日' },
  { key: 'week', label: '近7天' },
  { key: 'month', label: '近30天' },
  { key: 'twoMonths', label: '近2月' },
  { key: 'threeMonths', label: '近3月' },
];

// 运营名片 KPI：破冰、加群、报名、面试通过、整体转化。
// 加群是破冰后的运营侧支，分母取破冰人数（破冰后加群率），不并入线性漏斗。
// 页面可在「同一时段发生量」和「同批追踪 cohort」两种口径间切换。
export const KPI_DEFS: Array<{
  key: keyof ConversionKpisResponse;
  label: string;
  formula: string;
  tone: 'teal' | 'sky' | 'rose' | 'amber' | 'purple';
}> = [
  { key: 'breakIceRate', label: '破冰率', formula: '= 候选人回复 / 新增好友', tone: 'teal' },
  { key: 'groupInviteRate', label: '加群率', formula: '= 邀请进群 / 候选人回复', tone: 'rose' },
  { key: 'bookingRate', label: '报名转化率', formula: '= 报名成功 / 候选人回复', tone: 'sky' },
  {
    key: 'passRate',
    label: '面试通过率',
    formula: '= 面试通过 / 报名成功',
    tone: 'amber',
  },
  { key: 'overallRate', label: '整体转化率', formula: '= 面试通过 / 新增好友', tone: 'purple' },
];

export const CHART_COLORS = [
  THEME_COLORS.primary,
  THEME_COLORS.accent,
  THEME_COLORS.primaryLight,
  '#10b981',
  '#06b6d4',
  '#f59e0b',
  '#ef4444',
];

export type BotSortKey =
  | 'managerName'
  | 'groupName'
  | 'friends_added'
  | 'break_ice'
  | 'booking_success'
  | 'group_invite'
  | 'interview_pass'
  | 'booking_rate'
  | 'interview_rate';

export type SortDirection = 'asc' | 'desc';
