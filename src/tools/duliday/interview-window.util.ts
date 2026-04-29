import type { InterviewWindow } from './job-policy-parser';

export function normalizeHm(value?: string): string | null {
  if (!value) return null;
  const match = value.match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function compareTime(a: string, b: string): number {
  return a.localeCompare(b);
}

export function shiftDate(dateStr: string, offsetDays: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMillis = Date.UTC(year, month - 1, day) + offsetDays * 24 * 60 * 60 * 1000;
  const shifted = new Date(utcMillis);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getShanghaiWeekday(dateStr: string): string {
  const label = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(new Date(`${dateStr}T12:00:00+08:00`));

  const map: Record<string, string> = {
    星期一: '每周一',
    星期二: '每周二',
    星期三: '每周三',
    星期四: '每周四',
    星期五: '每周五',
    星期六: '每周六',
    星期日: '每周日',
    周一: '每周一',
    周二: '每周二',
    周三: '每周三',
    周四: '每周四',
    周五: '每周五',
    周六: '每周六',
    周日: '每周日',
  };

  return map[label] ?? label;
}

export function parseCycleDeadlineDay(raw?: string): number | null {
  if (!raw) return null;
  const normalized = raw.trim();
  if (!normalized) return null;
  if (/^-?\d+$/.test(normalized)) return Number(normalized);
  if (normalized === '当天' || normalized === '当日') return 0;
  if (normalized === '前一天' || normalized === '前1天') return -1;
  if (normalized === '前两天' || normalized === '前2天') return -2;
  return null;
}

export function normalizeDateTime(raw: string): string | null {
  const normalized = raw.replace(/\//g, '-').trim();
  const dateTimeMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}[:：]\d{2})(?::\d{2})?$/);
  if (!dateTimeMatch) return null;

  const date = dateTimeMatch[1];
  const hm = normalizeHm(dateTimeMatch[2]);
  if (!hm) return null;
  return `${date} ${hm}`;
}

export function resolveBookingDeadlineDateTime(
  interviewDate: string,
  window: InterviewWindow,
): string | null {
  if (window.fixedDeadline) {
    const fixed = normalizeDateTime(window.fixedDeadline);
    if (fixed) return fixed;

    const hm = normalizeHm(window.fixedDeadline);
    if (hm) return `${interviewDate} ${hm}`;
  }

  const dayOffset = parseCycleDeadlineDay(window.cycleDeadlineDay);
  const endHm = normalizeHm(window.cycleDeadlineEnd);
  if (dayOffset === null || !endHm) return null;

  const deadlineDate = shiftDate(interviewDate, dayOffset);
  return `${deadlineDate} ${endHm}`;
}

export function isDateOnlyWindow(window: InterviewWindow): boolean {
  return normalizeHm(window.startTime) === '00:00' && normalizeHm(window.endTime) === '00:00';
}

/**
 * 同日报名截止硬阻断检查。
 *
 * badcase 簇 `booking_same_day_cutoff`（5 条）—— 模型可以跳过 precheck 直接调
 * booking。这里把 precheck 中的"已超过报名截止"逻辑下沉成共享函数，让 booking
 * 工具入口也能拦下。
 *
 * @param interviewDate 申请的面试日期 (YYYY-MM-DD)
 * @param windows       该岗位的面试窗口列表
 * @param now           计算用的当前时间，默认 new Date()
 * @returns 命中阻断时返回 reason 与最晚截止时间；未命中返回 null
 */
export function findSameDayCutoffViolation(
  interviewDate: string,
  windows: InterviewWindow[],
  now: Date = new Date(),
): { reason: string; latestDeadline: string } | null {
  if (!interviewDate || windows.length === 0) return null;
  const todayStr = formatShanghaiDate(now);
  if (interviewDate !== todayStr) return null;

  const weekday = getShanghaiWeekday(interviewDate);
  const matchedWindows = windows.filter((window) => {
    if (window.date) return window.date === interviewDate;
    if (window.weekday) return window.weekday === weekday;
    return false;
  });
  if (matchedWindows.length === 0) return null;

  const nowDateTime = `${todayStr} ${formatShanghaiTime(now)}`;
  const deadlines = matchedWindows
    .map((window) => resolveBookingDeadlineDateTime(interviewDate, window))
    .filter((value): value is string => Boolean(value));
  if (deadlines.length === 0) return null;

  const allExpired = deadlines.every((deadline) => nowDateTime.localeCompare(deadline) > 0);
  if (!allExpired) return null;

  const latestDeadline = deadlines.sort((a, b) => a.localeCompare(b)).pop() as string;
  return {
    reason: `已超过 ${interviewDate} 的报名截止时间（最晚 ${latestDeadline}），不能再以今日为面试日期提交`,
    latestDeadline,
  };
}

function formatShanghaiDate(date: Date): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // zh-CN 默认输出 "2026/04/29"，归一化成 "2026-04-29"
  return fmt
    .format(date)
    .replace(/\//g, '-')
    .replace(/-(\d)(?=-|$)/g, '-0$1');
}

function formatShanghaiTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
