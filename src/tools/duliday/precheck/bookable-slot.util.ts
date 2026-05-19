/**
 * 面试时段构建：未来 N 天可约 slot + 周期性班次规则压缩 + 候选人请求日期评估。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）：
 * - buildUpcomingTimeOptions：未来 horizonDays 天扁平 label 数组（给候选人挑时间）
 * - buildBookableSlots：未来 N 天结构化 slot（含 bookingAllowed / requiresManualConfirmation）
 * - buildScheduleRule + formatWeekdayList + formatDeadlineClause：把周期窗口压缩成"周一至周五 10:00-12:00"
 * - evaluateRequestedDate：候选人指定日期 → available / unavailable / needs_confirmation
 */

import { formatLocalDate } from '@infra/utils/date.util';
import { normalizePolicyText, type InterviewWindow } from '@tools/utils/job-policy-parser';
import {
  compareTime,
  getShanghaiWeekday,
  isDateOnlyWindow,
  normalizeHm,
  resolveBookingDeadlineDateTime,
  shiftDate,
} from '@tools/duliday/booking/interview-window.util';
import { formatShanghaiDate, formatShanghaiTime } from '@tools/duliday/precheck/date.util';

const SHORT_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 生成未来 horizonDays 天内实际可约的面试时段（扁平 label 数组），不受 requestedDate 影响。
 * - 过滤已过报名截止的时段
 * - 今日时段会标注"今日"
 * - 上限 maxOptions 条
 */
export function buildUpcomingTimeOptions(
  windows: InterviewWindow[],
  horizonDays = 7,
  maxOptions = 10,
): string[] {
  if (windows.length === 0) return [];

  const now = new Date();
  const today = formatLocalDate(now);
  const nowTime = formatShanghaiTime(now);
  const nowDateTime = `${today} ${nowTime}`;

  type Option = {
    date: string;
    startTime: string;
    endTime: string;
    deadline: string | null;
    label: string;
  };
  const options: Option[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < horizonDays; i += 1) {
    const date = shiftDate(today, i);
    const weekday = getShanghaiWeekday(date);

    for (const window of windows) {
      if (window.date && window.date !== date) continue;
      if (!window.date && window.weekday && window.weekday !== weekday) continue;
      if (!window.date && !window.weekday) continue;

      const deadline = resolveBookingDeadlineDateTime(date, window);
      if (deadline && nowDateTime.localeCompare(deadline) > 0) continue;

      const key = `${date}|${window.startTime}|${window.endTime}|${deadline ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const weekdayShort = weekday.replace('每周', '周');
      const isToday = date === today;
      const deadlineText = deadline
        ? isToday
          ? `报名截止 ${deadline.slice(11)}` // 今日只保留 HH:mm
          : `报名截止 ${deadline}`
        : '';
      const todayTag = isToday ? '今日' : '';
      const suffixParts = [todayTag, deadlineText].filter(Boolean);
      const suffix = suffixParts.length > 0 ? `（${suffixParts.join('，')}）` : '';

      options.push({
        date,
        startTime: window.startTime,
        endTime: window.endTime,
        deadline,
        label: `${date} ${weekdayShort} ${window.startTime}-${window.endTime}${suffix}`,
      });
    }
  }

  options.sort((a, b) =>
    a.date === b.date ? compareTime(a.startTime, b.startTime) : a.date.localeCompare(b.date),
  );

  return options.slice(0, maxOptions).map((option) => option.label);
}

export function buildBookableSlots(params: {
  windows: InterviewWindow[];
  requestedDate?: string | null;
  horizonDays?: number;
  maxOptions?: number;
}): Array<Record<string, unknown>> {
  const { windows, requestedDate = null, horizonDays = 7, maxOptions = 10 } = params;
  if (windows.length === 0) return [];

  const now = new Date();
  const today = formatLocalDate(now);
  const nowTime = formatShanghaiTime(now);
  const nowDateTime = `${today} ${nowTime}`;
  const dates = new Set<string>();

  for (let i = 0; i < horizonDays; i += 1) {
    dates.add(shiftDate(today, i));
  }
  if (requestedDate) dates.add(requestedDate);

  const slots: Array<Record<string, unknown> & { date: string; startTime: string }> = [];
  const seen = new Set<string>();

  for (const date of dates) {
    const weekday = getShanghaiWeekday(date);

    for (const window of windows) {
      if (window.date && window.date !== date) continue;
      if (!window.date && window.weekday && window.weekday !== weekday) continue;
      if (!window.date && !window.weekday) continue;

      const registrationDeadline = resolveBookingDeadlineDateTime(date, window);
      if (registrationDeadline && nowDateTime.localeCompare(registrationDeadline) > 0) continue;

      const key = `${date}|${window.startTime}|${window.endTime}|${registrationDeadline ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const weekdayShort = weekday.replace('每周', '周');
      const dateOnly = isDateOnlyWindow(window);
      const normalizedStart = normalizeHm(window.startTime);
      const base = {
        date,
        weekday: weekdayShort,
        startTime: window.startTime,
        endTime: window.endTime,
        label: `${date} ${weekdayShort} ${window.startTime}-${window.endTime}`,
        registrationDeadline,
      };

      slots.push(
        dateOnly
          ? {
              ...base,
              dateOnly: true,
              bookingAllowed: false,
              requiresManualConfirmation: true,
              reason:
                '该面试窗口只标注日期，没有明确几点面试；不要自动调用预约工具，先让同事确认具体提交时间。',
            }
          : !normalizedStart
            ? {
                ...base,
                dateOnly: false,
                bookingAllowed: false,
                requiresManualConfirmation: true,
                reason:
                  '该面试窗口缺少可识别的具体开始时间；不要自动调用预约工具，先让同事确认具体提交时间。',
              }
            : {
                ...base,
                dateOnly: false,
                bookingAllowed: true,
                interviewTime: `${date} ${normalizedStart}:00`,
              },
      );
    }
  }

  slots.sort((a, b) =>
    a.date === b.date ? compareTime(a.startTime, b.startTime) : a.date.localeCompare(b.date),
  );

  if (requestedDate) {
    const requestedSlots = slots.filter((slot) => slot.date === requestedDate);
    const otherSlots = slots
      .filter((slot) => slot.date !== requestedDate)
      .slice(0, Math.max(0, maxOptions - requestedSlots.length));
    return [...requestedSlots, ...otherSlots];
  }

  return slots.slice(0, maxOptions);
}

/**
 * 将周期性面试窗口压缩为人类可读的规则总结。
 * - 同 startTime/endTime/deadline 的窗口按 weekday 合并
 * - 连续 3 天以上用"周一至周五"表示，否则用"周一、三、五"
 * - 固定日期窗口不纳入规则总结（由 upcomingTimeOptions 表达）
 * - 没有任何周期性窗口时返回空字符串
 */
export function buildScheduleRule(windows: InterviewWindow[]): string {
  const periodic = windows.filter((window) => window.weekday);
  if (periodic.length === 0) return '';

  const groups = new Map<
    string,
    { windows: InterviewWindow[]; startTime: string; endTime: string }
  >();
  for (const window of periodic) {
    const key = [
      window.startTime,
      window.endTime,
      window.fixedDeadline ?? '',
      window.cycleDeadlineDay ?? '',
      window.cycleDeadlineEnd ?? '',
    ].join('|');
    if (!groups.has(key)) {
      groups.set(key, { windows: [], startTime: window.startTime, endTime: window.endTime });
    }
    groups.get(key)!.windows.push(window);
  }

  const parts: string[] = [];
  for (const group of groups.values()) {
    const weekdayStr = formatWeekdayList(group.windows.map((window) => window.weekday || ''));
    if (!weekdayStr) continue;
    const timeStr = `${group.startTime}-${group.endTime}`;
    const deadlineClause = formatDeadlineClause(group.windows[0]);
    parts.push(
      deadlineClause ? `${weekdayStr} ${timeStr}，${deadlineClause}` : `${weekdayStr} ${timeStr}`,
    );
  }

  return parts.join('；');
}

function formatWeekdayList(weekdays: string[]): string {
  const indices = Array.from(
    new Set(
      weekdays
        .map((weekday) => {
          const match = weekday.match(/[一二三四五六日天]/);
          if (!match) return -1;
          const char = match[0] === '天' ? '日' : match[0];
          return SHORT_WEEKDAYS.indexOf(char);
        })
        .filter((index) => index >= 0),
    ),
  ).sort((a, b) => a - b);

  if (indices.length === 0) return '';

  const isConsecutive = indices.every((value, i) => i === 0 || value === indices[i - 1] + 1);
  if (indices.length >= 3 && isConsecutive) {
    return `周${SHORT_WEEKDAYS[indices[0]]}至周${SHORT_WEEKDAYS[indices[indices.length - 1]]}`;
  }

  return `周${indices.map((index) => SHORT_WEEKDAYS[index]).join('、')}`;
}

function formatDeadlineClause(window: InterviewWindow): string {
  if (window.fixedDeadline) return `截止 ${window.fixedDeadline}`;
  const dayLabel = normalizePolicyText(window.cycleDeadlineDay);
  const endTime = normalizePolicyText(window.cycleDeadlineEnd);
  if (dayLabel && endTime) return `${dayLabel} ${endTime} 前报名`;
  return '';
}

export function evaluateRequestedDate(params: {
  date: string;
  windows: InterviewWindow[];
  basePolicyNotes?: string[];
}): {
  status: 'available' | 'unavailable' | 'needs_confirmation';
  canSchedule: boolean | null;
  matchedWindows: InterviewWindow[];
  reason: string;
  policyNotes: string[];
  decisionBasis:
    | 'no_matching_schedule'
    | 'after_booking_deadline'
    | 'future_schedule_match'
    | 'same_day_before_window'
    | 'same_day_after_latest_window'
    | 'same_day_window_requires_confirmation';
} {
  const { date, windows, basePolicyNotes = [] } = params;
  const weekday = getShanghaiWeekday(date);
  const now = new Date();
  const today = formatShanghaiDate(now);
  const nowTime = formatShanghaiTime(now);
  const nowDateTime = `${today} ${nowTime}`;
  const matchedWindows = windows.filter((window) => {
    if (window.date) return window.date === date;
    if (window.weekday) return window.weekday === weekday;
    return false;
  });

  if (matchedWindows.length === 0) {
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows: [],
      reason: `${date} 没有可预约的面试时段`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'no_matching_schedule',
    };
  }

  const deadlineChecks = matchedWindows.map((window) => {
    const deadlineDateTime = resolveBookingDeadlineDateTime(date, window);
    const expired = deadlineDateTime ? nowDateTime.localeCompare(deadlineDateTime) > 0 : false;
    return { window, deadlineDateTime, expired };
  });
  const hasExplicitDeadlines = deadlineChecks.some((item) => Boolean(item.deadlineDateTime));
  const validDeadlineWindows = deadlineChecks
    .filter((item) => !item.deadlineDateTime || !item.expired)
    .map((item) => item.window);
  const expiredDeadlines = deadlineChecks
    .filter((item) => item.deadlineDateTime && item.expired)
    .map((item) => item.deadlineDateTime as string);

  if (hasExplicitDeadlines && validDeadlineWindows.length === 0) {
    const latestDeadline = expiredDeadlines.sort((a, b) => a.localeCompare(b)).pop();
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows: [],
      reason: latestDeadline
        ? `已超过报名截止时间（最晚截止：${latestDeadline}）`
        : '已超过报名截止时间',
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'after_booking_deadline',
    };
  }

  const effectiveWindows = validDeadlineWindows.length > 0 ? validDeadlineWindows : matchedWindows;

  if (date !== today) {
    return {
      status: 'available',
      canSchedule: true,
      matchedWindows: effectiveWindows,
      reason: `${date} 有可预约的面试时段`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'future_schedule_match',
    };
  }

  const latestEnd = effectiveWindows
    .map((window) => window.endTime || window.startTime)
    .sort((a, b) => compareTime(a, b))
    .pop();

  if (latestEnd && compareTime(nowTime, latestEnd) > 0) {
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows: effectiveWindows,
      reason: `今天的面试时段已结束（最晚到 ${latestEnd}）`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'same_day_after_latest_window',
    };
  }

  // 如果所有有效窗口都尚未开始（now < 最早 startTime），且之前已通过报名截止检查，
  // 则今日仍可预约，直接返回 available，不让 LLM 生成暧昧话术。
  const earliestStart = effectiveWindows
    .map((window) => window.startTime)
    .filter(Boolean)
    .sort((a, b) => compareTime(a, b))[0];

  if (earliestStart && compareTime(nowTime, earliestStart) < 0) {
    return {
      status: 'available',
      canSchedule: true,
      matchedWindows: effectiveWindows,
      reason: `今天还可以预约面试（最早时段 ${earliestStart} 开始）`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'same_day_before_window',
    };
  }

  return {
    status: 'needs_confirmation',
    canSchedule: null,
    matchedWindows: effectiveWindows,
    reason: '今天有面试时段，是否还能预约需以预约接口结果为准',
    policyNotes: [...basePolicyNotes],
    decisionBasis: 'same_day_window_requires_confirmation',
  };
}
