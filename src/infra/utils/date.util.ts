/**
 * 日期工具函数（显式 Asia/Shanghai 时区）
 *
 * 服务器 Docker 容器默认 UTC，必须显式指定时区。
 * - formatLocalDate: YYYY-MM-DD
 * - formatLocalDateTime: YYYY-MM-DD HH:mm:ss
 */

const TIMEZONE = 'Asia/Shanghai';

/**
 * 格式化日期为 YYYY-MM-DD（Asia/Shanghai 时区）
 */
export function formatLocalDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
