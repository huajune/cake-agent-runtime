import type {
  ConversionBotsResponse,
  ConversionFunnelResponse,
  ConversionHandoffResponse,
  ConversionKpisResponse,
  ConversionMetricMode,
  ConversionTrendPoint,
  ConversionTrendResponse,
} from '../types/conversion-analytics.types';

// 演示数据模式（仅 dev 构建生效）：本地库通常没有转化数据，URL 带 ?demo=1 时
// API 层直接返回这组仿真数据，用于 UI 调样式/动效，不发任何真实请求。
export function isDemoMode(): boolean {
  if (!import.meta.env.DEV) return false;
  return new URLSearchParams(window.location.search).has('demo');
}

export const DEMO_KPIS: ConversionKpisResponse = {
  breakIceRate: { current: 0.742, previous: 0.695, change: 4.7, numerator: 617, denominator: 831 },
  bookingRate: { current: 0.067, previous: 0.055, change: 1.2, numerator: 56, denominator: 834 },
  groupInviteRate: {
    current: 0.435,
    previous: 0.456,
    change: -2.1,
    numerator: 363,
    denominator: 834,
  },
  passRate: { current: 0.143, previous: 0.109, change: 3.4, numerator: 8, denominator: 56 },
  overallRate: { current: 0.01, previous: 0.008, change: 0.2, numerator: 8, denominator: 831 },
};

export const DEMO_BOTS: ConversionBotsResponse = {
  bots: [
    {
      botImId: 'demo-bot-1',
      managerName: '李宇杭',
      groupName: '宇航组',
      eventCounts: {
        friends_added: 63,
        break_ice: 64,
        group_invite: 36,
        booking_success: 5,
        interview_pass: 0,
        booking_cancel: 0,
        interview_modified: 0,
      },
      overallRate: 0,
      status: 'good',
    },
    {
      botImId: 'demo-bot-2',
      managerName: '独立客招聘经理徐哥',
      groupName: '小祝组',
      eventCounts: {
        friends_added: 255,
        break_ice: 246,
        group_invite: 139,
        booking_success: 19,
        interview_pass: 1,
        booking_cancel: 0,
        interview_modified: 0,
      },
      overallRate: 0.004,
      status: 'good',
    },
    {
      botImId: 'demo-bot-3',
      managerName: '高雅琪',
      groupName: '琪琪组',
      eventCounts: {
        friends_added: 191,
        break_ice: 199,
        group_invite: 48,
        booking_success: 13,
        interview_pass: 3,
        booking_cancel: 2,
        interview_modified: 1,
      },
      overallRate: 0.016,
      status: 'good',
    },
    {
      botImId: 'demo-bot-4',
      managerName: '祝东升',
      groupName: '小祝组',
      eventCounts: {
        friends_added: 259,
        break_ice: 261,
        group_invite: 115,
        booking_success: 17,
        interview_pass: 3,
        booking_cancel: 1,
        interview_modified: 1,
      },
      overallRate: 0.012,
      status: 'warning',
    },
    {
      botImId: 'demo-bot-5',
      managerName: '吴盼盼',
      groupName: '盼盼组',
      eventCounts: {
        friends_added: 29,
        break_ice: 26,
        group_invite: 14,
        booking_success: 1,
        interview_pass: 0,
        booking_cancel: 1,
        interview_modified: 0,
      },
      overallRate: 0,
      status: 'warning',
    },
    {
      botImId: 'demo-bot-6',
      managerName: '李涵婷',
      groupName: '南瓜组',
      eventCounts: {
        friends_added: 25,
        break_ice: 31,
        group_invite: 11,
        booking_success: 1,
        interview_pass: 1,
        booking_cancel: 0,
        interview_modified: 0,
      },
      overallRate: 0.04,
      status: 'bad',
    },
    {
      botImId: 'demo-bot-7',
      managerName: '郭晓阳',
      groupName: '晓阳测试组',
      eventCounts: {
        friends_added: 9,
        break_ice: 7,
        group_invite: 0,
        booking_success: 0,
        interview_pass: 0,
        booking_cancel: 0,
        interview_modified: 0,
      },
      overallRate: 0,
      status: 'bad',
    },
  ],
};

export function buildDemoFunnel(mode: ConversionMetricMode): ConversionFunnelResponse {
  return {
    mode,
    cohort: 'friend_added',
    totalCohort: 831,
    stages: [
      { stage: 'friend_added', displayName: '新增好友', count: 831, overallRate: 1, stageRate: 1 },
      { stage: 'break_ice', displayName: '破冰', count: 617, overallRate: 0.742, stageRate: 0.742 },
      { stage: 'booking', displayName: '报名', count: 56, overallRate: 0.067, stageRate: 0.091 },
      {
        stage: 'interview_pass',
        displayName: '面试通过',
        count: 8,
        overallRate: 0.01,
        stageRate: 0.143,
      },
    ],
  };
}

export function buildDemoTrends(mode: ConversionMetricMode): ConversionTrendResponse {
  const days = 14;
  const points: ConversionTrendPoint[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    // 用正弦叠加构造平滑但有起伏的曲线，避免随机数导致每次渲染抖动。
    const wave = Math.sin((days - i) * 0.9) * 0.5 + Math.sin((days - i) * 0.37 + 1.2) * 0.5;
    const friendAdded = Math.round(58 + wave * 18);
    const breakIce = Math.round(friendAdded * (0.68 + wave * 0.06));
    const groupInvite = Math.round(breakIce * (0.42 + wave * 0.05));
    const booking = Math.max(1, Math.round(breakIce * (0.06 + wave * 0.02)));
    const interviewPass = Math.round(booking * (0.12 + Math.max(0, wave) * 0.08));
    points.push({
      date: date.toISOString().slice(0, 10),
      friendAdded,
      breakIce,
      booking,
      interviewPass,
      groupInvite,
      breakIceRate: breakIce / friendAdded,
      bookingRate: booking / breakIce,
      groupInviteRate: groupInvite / breakIce,
      passRate: booking > 0 ? interviewPass / booking : null,
      overallRate: interviewPass / friendAdded,
    });
  }
  const summary = points.reduce(
    (acc, p) => ({
      friendAdded: acc.friendAdded + p.friendAdded,
      breakIce: acc.breakIce + p.breakIce,
      booking: acc.booking + p.booking,
      interviewPass: acc.interviewPass + p.interviewPass,
      groupInvite: acc.groupInvite + p.groupInvite,
    }),
    { friendAdded: 0, breakIce: 0, booking: 0, interviewPass: 0, groupInvite: 0 },
  );
  return { mode, summary, points };
}

export const DEMO_HANDOFF: ConversionHandoffResponse = {
  total: 37,
  reasons: [
    { reasonCode: 'user_request', displayName: '候选人要求人工', count: 12, percent: 0.324 },
    { reasonCode: 'job_mismatch', displayName: '岗位无法匹配', count: 9, percent: 0.243 },
    { reasonCode: 'booking_anomaly', displayName: '报名信息异常', count: 6, percent: 0.162 },
    { reasonCode: 'no_break_ice', displayName: '多次未破冰', count: 5, percent: 0.135 },
    { reasonCode: 'other', displayName: '其他', count: 5, percent: 0.135 },
  ],
};
