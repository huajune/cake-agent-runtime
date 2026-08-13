import { formatLocalDateWithWeekday, getLocalDayStart } from '@infra/utils/date.util';

const DAY_MS = 86_400_000;

/**
 * 复聊话术沿用既有 zh-CN 展示格式（如 2026/8/13 14:30）。
 * 该格式面向候选人展示，不与 prompt 的 YYYY-MM-DD 时间锚合并。
 */
export function formatShanghaiTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function formatRelativeShanghaiDate(timestamp: number, now: number): string {
  const targetDay = shanghaiDayNumber(timestamp);
  const currentDay = shanghaiDayNumber(now);
  if (targetDay === currentDay) return '今天（只能说“今天”，不得说“明天”）';
  if (targetDay === currentDay + 1) return '明天（只能说“明天”，不得说“今天”）';
  return `${formatShanghaiDate(timestamp)}（使用具体日期，不要说“今天”或“明天”）`;
}

export function formatShanghaiClock(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function shanghaiDayNumber(timestamp: number): number {
  return getLocalDayStart(new Date(timestamp)).getTime() / DAY_MS;
}

export function formatShanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(timestamp));
}

export function formatShanghaiDateWithWeekday(timestamp: number, offsetDays: number): string {
  return formatLocalDateWithWeekday(new Date(timestamp + offsetDays * DAY_MS));
}
