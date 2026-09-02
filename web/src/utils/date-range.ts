export function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function isWeekendDate(date: Date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** 两个 YYYY-MM-DD 之间（含两端）的工作日日期键。 */
export function buildBusinessDateRangeBetween(startKey: string, endKey: string) {
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = endKey.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (!isWeekendDate(d)) out.push(formatDateKey(d));
  }
  return out;
}

export function buildRecentBusinessDateRange(days: number) {
  const endDate = new Date();
  const startDate = addDays(endDate, -(days - 1));

  return Array.from({ length: days }, (_, index) => addDays(startDate, index))
    .filter((date) => !isWeekendDate(date))
    .map(formatDateKey);
}
