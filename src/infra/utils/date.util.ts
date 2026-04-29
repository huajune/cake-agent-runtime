/**
 * 日期工具函数（显式 Asia/Shanghai 时区）
 *
 * 服务器 Docker 容器默认 UTC，必须显式指定时区。
 * - formatLocalDate: YYYY-MM-DD
 * - formatLocalDateTime: YYYY-MM-DD HH:mm:ss
 */

export const LOCAL_TIMEZONE = 'Asia/Shanghai';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getLocalDateTimeParts(date: Date): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

function createShanghaiDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - SHANGHAI_OFFSET_MS,
  );
}

/**
 * 格式化日期为 YYYY-MM-DD（Asia/Shanghai 时区）
 */
export function formatLocalDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCAL_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${d}`;
}

/**
 * 格式化日期为 YYYY-MM-DD HH:mm（Asia/Shanghai 时区）
 */
export function formatLocalMinute(date: Date): string {
  const parts = getLocalDateTimeParts(date);
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  const h = String(parts.hour).padStart(2, '0');
  const min = String(parts.minute).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * 获取 Asia/Shanghai 时区下指定日期的当天 00:00 对应的真实时间点。
 */
export function getLocalDayStart(date = new Date()): Date {
  const parts = getLocalDateTimeParts(date);
  return createShanghaiDate(parts.year, parts.month, parts.day);
}

/**
 * 获取 Asia/Shanghai 时区下指定日期所在小时的整点时间。
 */
export function getLocalHourStart(date = new Date()): Date {
  const parts = getLocalDateTimeParts(date);
  return createShanghaiDate(parts.year, parts.month, parts.day, parts.hour);
}

/**
 * 获取 Asia/Shanghai 时区下指定日期所在周的周一 00:00。
 */
export function getLocalWeekStart(date = new Date()): Date {
  const dayStart = getLocalDayStart(date);
  const localWeekday = new Date(dayStart.getTime() + SHANGHAI_OFFSET_MS).getUTCDay();
  const daysSinceMonday = (localWeekday + 6) % 7;
  return addLocalDays(dayStart, -daysSinceMonday);
}

/**
 * 获取 Asia/Shanghai 时区下指定日期所在月的 1 日 00:00。
 */
export function getLocalMonthStart(date = new Date(), monthOffset = 0): Date {
  const parts = getLocalDateTimeParts(date);
  return createShanghaiDate(parts.year, parts.month + monthOffset, 1);
}

/**
 * 按 Asia/Shanghai 自然日增减日期。
 */
export function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * 将 YYYY-MM-DD 解析为 Asia/Shanghai 当天 00:00。
 */
export function parseLocalDateStart(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return createShanghaiDate(year, month, day);
}

/**
 * 获取 Asia/Shanghai 时区的"明天"日期字符串 YYYY-MM-DD
 */
export function getTomorrowDate(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return formatLocalDate(tomorrow);
}

/**
 * 格式化日期为 YYYY-MM-DD HH:mm:ss（Asia/Shanghai 时区）
 */
export function formatLocalDateTime(date: Date): string {
  const parts = getLocalDateTimeParts(date);
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  const h = String(parts.hour).padStart(2, '0');
  const min = String(parts.minute).padStart(2, '0');
  const s = String(parts.second).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}
