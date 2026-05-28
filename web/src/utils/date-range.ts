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

export function buildRecentBusinessDateRange(days: number) {
  const endDate = new Date();
  const startDate = addDays(endDate, -(days - 1));

  return Array.from({ length: days }, (_, index) => addDays(startDate, index))
    .filter((date) => !isWeekendDate(date))
    .map(formatDateKey);
}
