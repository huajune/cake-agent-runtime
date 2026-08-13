/** 中文数字字符 → 基数（0-10，含“两”）。 */
export const CHINESE_CARDINAL: Readonly<Record<string, number>> = Object.freeze({
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
});

/** 中文星期字符 → ISO 星期索引（周一=1 … 周日=7）。 */
export const CHINESE_WEEKDAY_ISO: Readonly<Record<string, number>> = Object.freeze({
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
});

/** ISO 星期索引 → JS Date#getDay() 索引（周日=0）。 */
export function isoWeekdayToJsDay(iso: number): number {
  return iso % 7;
}

/** 中文星期短文案表，下标即 Date#getDay()。 */
export const WEEKDAY_LABELS_SHORT = Object.freeze([
  '周日',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
]);

/** 中文星期长文案表，下标即 Date#getDay()。 */
export const WEEKDAY_LABELS_LONG = Object.freeze([
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
]);
