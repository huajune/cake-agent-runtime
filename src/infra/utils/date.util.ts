/**
 * 日期工具函数（Asia/Shanghai 时区安全）
 */

/**
 * 格式化日期为 YYYY-MM-DD（使用本地时区，而非 UTC）
 *
 * toISOString().split('T')[0] 在 UTC+8 的 0:00-8:00 之间会返回前一天日期，
 * 本函数使用本地日期部分，避免时区偏移。
 */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
