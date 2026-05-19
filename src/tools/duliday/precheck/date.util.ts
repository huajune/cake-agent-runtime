/**
 * 候选人输入的日期/周几解析 + Shanghai 时区格式化。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）：
 * - normalizeRequestedDate：把"今天/明天/后天/本周三/下周一/3月5日/2026-03-05"
 *   统一解析成 YYYY-MM-DD
 * - resolveWeeklyDateExpression / resolveDateFromWeekday：周表达式解析
 * - resolveMonthDayToNearestFutureDate：补全 year（取最近未来）
 * - toDateString：合法 Y/M/D 兜底校验
 * - formatShanghaiTime / formatShanghaiDate：Asia/Shanghai TZ 输出
 *
 * 业务约束：所有候选人输入的日期都按"上海当前日"为锚点处理；周几没指定 prefix
 * 时默认本周尚未过去那一天，过期则跳到下周。
 */

import { formatLocalDate, getTomorrowDate } from '@infra/utils/date.util';
import { normalizePolicyText } from '@tools/utils/job-policy-parser';
import { getShanghaiWeekday, shiftDate } from '@tools/duliday/booking/interview-window.util';

export function normalizeRequestedDate(input?: string): {
  date: string | null;
  normalizedInput: string | null;
  error?: string;
} {
  const raw = normalizePolicyText(input);
  if (!raw) return { date: null, normalizedInput: null };
  const normalizedInput = raw.toLowerCase();
  const today = formatLocalDate(new Date());

  if (normalizedInput === 'today' || raw === '今天') {
    return { date: today, normalizedInput };
  }
  if (normalizedInput === 'tomorrow' || raw === '明天') {
    return { date: getTomorrowDate(), normalizedInput };
  }
  if (raw === '后天') {
    return { date: shiftDate(today, 2), normalizedInput };
  }

  const weeklyDate = resolveWeeklyDateExpression(raw, today);
  if (weeklyDate) {
    return { date: weeklyDate, normalizedInput };
  }

  const monthDay = raw.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (monthDay) {
    const resolved = resolveMonthDayToNearestFutureDate(
      Number(monthDay[1]),
      Number(monthDay[2]),
      today,
    );
    if (!resolved) {
      return { date: null, normalizedInput, error: `无法识别的日期：${raw}` };
    }
    return { date: resolved, normalizedInput };
  }

  const fullDate = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (fullDate) {
    const formatted = toDateString(Number(fullDate[1]), Number(fullDate[2]), Number(fullDate[3]));
    if (!formatted) {
      return { date: null, normalizedInput, error: `无法识别的日期：${raw}` };
    }
    return { date: formatted, normalizedInput };
  }

  const normalized = raw.replace(/\//g, '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return { date: normalized, normalizedInput };
  }

  return { date: null, normalizedInput, error: `无法识别的日期：${raw}` };
}

function getWeekdayIndexFromChinese(token: string): number | null {
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 7,
  };
  return map[token] ?? null;
}

function getWeekdayIndexByDate(dateStr: string): number {
  const weekday = getShanghaiWeekday(dateStr);
  const map: Record<string, number> = {
    每周一: 1,
    每周二: 2,
    每周三: 3,
    每周四: 4,
    每周五: 5,
    每周六: 6,
    每周日: 7,
  };
  return map[weekday] ?? 1;
}

export function resolveWeeklyDateExpression(raw: string, today: string): string | null {
  const thisWeekMatch = raw.match(/^(本周|这周|本星期|这星期)([一二三四五六日天1-7])$/);
  if (thisWeekMatch) {
    return resolveDateFromWeekday(today, thisWeekMatch[2], {
      weekOffset: 0,
      keepPastInCurrentWeek: true,
    });
  }

  const nextWeekMatch = raw.match(/^(下周|下星期)([一二三四五六日天1-7])$/);
  if (nextWeekMatch) {
    return resolveDateFromWeekday(today, nextWeekMatch[2], {
      weekOffset: 1,
      keepPastInCurrentWeek: true,
    });
  }

  const plainWeekMatch = raw.match(/^(周|星期)([一二三四五六日天1-7])$/);
  if (plainWeekMatch) {
    return resolveDateFromWeekday(today, plainWeekMatch[2], {
      weekOffset: 0,
      keepPastInCurrentWeek: false,
    });
  }

  return null;
}

export function resolveDateFromWeekday(
  today: string,
  weekdayToken: string,
  options: { weekOffset: number; keepPastInCurrentWeek: boolean },
): string | null {
  const targetWeekday = getWeekdayIndexFromChinese(weekdayToken);
  if (!targetWeekday) return null;

  const currentWeekday = getWeekdayIndexByDate(today);
  const monday = shiftDate(today, -(currentWeekday - 1));
  let target = shiftDate(monday, targetWeekday - 1 + options.weekOffset * 7);

  if (!options.keepPastInCurrentWeek && target < today) {
    target = shiftDate(target, 7);
  }

  return target;
}

export function toDateString(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function resolveMonthDayToNearestFutureDate(
  month: number,
  day: number,
  today: string,
): string | null {
  const currentYear = Number(today.slice(0, 4));
  const thisYear = toDateString(currentYear, month, day);
  if (thisYear && thisYear >= today) return thisYear;
  return toDateString(currentYear + 1, month, day);
}

export function formatShanghaiTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatShanghaiDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
