/**
 * 岗位量化事实的出处匹配（纯函数，零 LLM），供 job_fact_without_provenance 对账。
 *
 * 规则问的是"回复里的距离 / 薪资 / 班次数字在会话里出现过没有"。逐字子串对账会把同一事实的
 * 另一种写法当成无出处：2026-09-10 ~ 10-14 生产 138 次命中中，约四分之三的被判数字其实能在
 * 来源里找到（"约 7km"↔记忆"7.0km"、"22:00-07:00"↔"22:00-次日07:00"、候选人写的
 * "9.30-16.30"/"八点半到五点半"）。这里把来源解析成按行分组的结构化索引，再按事实种类比对：
 *
 * - 距离：按数值比；整数公里落在某个来源距离的取整区间内（8.7km → "9 公里"/"8 公里多"）也算；
 * - 班次：剥"次日/凌晨"；起止两端出现在同一行来源里即算（合并相邻班次、复述候选人的可上班
 *   时间）。中文口语时刻（"八点半""下午五点"）没写上下午时按 12 小时制两种读法都收；
 * - 薪资：单个数值出现在来源薪资语境（后接 元/块//时·天·月，或前有 薪资/时薪/基础 等；来源区间
 *   "22-28元/时""月薪3000-4000"的两端都算）即算；区间两端须在同一行；日薪等于来源时薪 × 1~12 小时
 *   （半小时粒度）、时薪等于同一行"时薪 × N 倍"（法定节假日 3 倍）也算。月收入估算不推导，仍要原文出处。
 *
 * 同行约束是为了不让散落在不同岗位里的常见数字（10:00、14:00、22 元）拼出一个"有出处"的假区间。
 * 规范形建立在 job-fact-signals 的 `normalizeQuantifiedJobFact` 之上（单位前置薪资"月薪N"↔"N元/月"
 * 同一形），这里只追加出处对账才需要的步骤：点号时刻、连写区间符、剥"次日/凌晨"。
 */

import { normalizeQuantifiedJobFact } from './job-fact-signals.util';

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
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
};

/** 点号写的时刻（"9.30-16.30""7.00--16:30"）：区间另一端也是时刻才转，避免误伤"19.50-21.50 元"。 */
const DOTTED_RANGE_START_PATTERN =
  /(\d{1,2})[.．]([0-5]\d)(?=\s*[-~—至到]+\s*(?:次日|凌晨)?\s*\d{1,2}[.．:：][0-5]\d(?!\s*(?:\d|元|块|\/)))/gu;
const DOTTED_RANGE_END_PATTERN =
  /(?<=\d{1,2}[.．:：][0-5]\d\s*[-~—至到]+\s*(?:次日|凌晨)?\s*)(\d{1,2})[.．]([0-5]\d)(?!\s*(?:\d|元|块|\/))/gu;
/** 来源里单独出现的点号时刻（"下午17点21.30都可以"），只进时刻索引。 */
const LONE_DOTTED_TIME_PATTERN =
  /(?<![\d.])(\d{1,2})[.．]([0-5]\d)(?![\d.]|\s*(?:元|块|\/|%|km|公里))/gu;
const CLOCK_TIME_PATTERN = /(\d{1,2}):(\d{2})/g;
const BARE_HOUR_RANGE_PATTERN = /(\d{1,2})-(\d{1,2})点/g;
const SPOKEN_TIME_PATTERN =
  /(上午|早上|早晨|早|中午|下午|傍晚|晚上|晚|凌晨|半夜)?([零〇一二两三四五六七八九十\d]{1,3})点(半|(\d{1,2})(?![.．:：\d])分?|([零一二三四五]?十[一二三四五六七八九]?)分)?/gu;
const DISTANCE_PATTERN = /(\d+(?:\.\d+)?)(?:km|千米)/g;
const SALARY_AFTER_PATTERN = /(\d+(?:\.\d+)?)(?=元|块|\/(?:时|天|月))/g;
/** 来源薪资区间的下限（"22-28元/时"的 22；"月薪3000-4000"规整后同形）。 */
const SALARY_RANGE_LOW_PATTERN = /(\d+(?:\.\d+)?)-(?=\d+(?:\.\d+)?(?:元|块|\/(?:时|天|月)))/g;
const SALARY_BEFORE_PATTERN =
  /(?:薪资|时薪|日薪|月薪|底薪|保底|基础|综合|工资)[:：]?(\d+(?:\.\d+)?)/g;
const HOURLY_RATE_PATTERN = /(\d+(?:\.\d+)?)(?:元)?\/时/g;
const PAY_MULTIPLIER_PATTERN = /([1-5一二两三四五])倍/g;

export interface JobFactProvenanceIndex {
  /** 全部来源按事实口径归一后的拼接，先做整串命中（兼容既有逐字口径）。 */
  readonly normalizedText: string;
  readonly distancesKm: readonly number[];
  /** 每行来源里出现的时刻（HH:MM），班次区间两端须同属一行。 */
  readonly clockTimesByLine: readonly ReadonlySet<string>[];
  /** 每行来源里处在薪资语境的数值。 */
  readonly salaryNumbersByLine: readonly ReadonlySet<string>[];
  readonly hourlyRates: readonly number[];
  /** 同一行里"时薪 × N 倍"得出的时薪（"25元/时，法定节假日3倍"→ 75）。 */
  readonly multipliedHourlyRates: readonly string[];
}

/**
 * 出处对账用的规范形：在共享规范形（去空白、时段补零、单位同义、单位前置薪资）之上，
 * 先把点号时刻转成冒号，再合并连写区间符（"7.00--16:30"）并剥掉区间后端的"次日/凌晨"。
 */
export function normalizeJobFact(text: string): string {
  return normalizeQuantifiedJobFact(
    text.replace(DOTTED_RANGE_START_PATTERN, '$1:$2').replace(DOTTED_RANGE_END_PATTERN, '$1:$2'),
  )
    .replace(/-{2,}/g, '-')
    .replace(/(?<=-)(?:次日|凌晨|第二天|隔天)/g, '');
}

export function buildJobFactProvenanceIndex(texts: readonly string[]): JobFactProvenanceIndex {
  const lines = texts.flatMap((text) => text.split('\n')).map(normalizeJobFact);
  const distancesKm: number[] = [];
  const hourlyRates: number[] = [];
  const multipliedHourlyRates: string[] = [];
  const clockTimesByLine: Set<string>[] = [];
  const salaryNumbersByLine: Set<string>[] = [];

  for (const line of lines) {
    if (!line) continue;
    for (const match of line.matchAll(DISTANCE_PATTERN)) distancesKm.push(Number(match[1]));
    const lineRates = [...line.matchAll(HOURLY_RATE_PATTERN)].map((match) => Number(match[1]));
    hourlyRates.push(...lineRates);
    for (const match of line.matchAll(PAY_MULTIPLIER_PATTERN)) {
      const factor = parseChineseInt(match[1]);
      if (factor === null) continue;
      for (const rate of lineRates) multipliedHourlyRates.push(numberKey(String(rate * factor)));
    }

    const times = new Set<string>();
    for (const match of line.matchAll(CLOCK_TIME_PATTERN)) {
      times.add(formatClock(Number(match[1]), Number(match[2])));
    }
    for (const match of line.matchAll(BARE_HOUR_RANGE_PATTERN)) {
      times.add(formatClock(Number(match[1]), 0));
      times.add(formatClock(Number(match[2]), 0));
    }
    for (const match of line.matchAll(LONE_DOTTED_TIME_PATTERN)) {
      if (Number(match[1]) <= 24) times.add(formatClock(Number(match[1]), Number(match[2])));
    }
    for (const time of parseSpokenTimes(line)) times.add(time);
    if (times.size > 0) clockTimesByLine.push(times);

    const salaries = new Set<string>();
    for (const match of line.matchAll(SALARY_AFTER_PATTERN)) salaries.add(numberKey(match[1]));
    for (const match of line.matchAll(SALARY_RANGE_LOW_PATTERN)) salaries.add(numberKey(match[1]));
    for (const match of line.matchAll(SALARY_BEFORE_PATTERN)) salaries.add(numberKey(match[1]));
    if (salaries.size > 0) salaryNumbersByLine.push(salaries);
  }

  return {
    normalizedText: lines.join('\n'),
    distancesKm,
    clockTimesByLine,
    salaryNumbersByLine,
    hourlyRates,
    multipliedHourlyRates,
  };
}

/** `fact` 为 QUANTIFIED_JOB_FACT_PATTERN 命中的原文片段。 */
export function isJobFactSupported(fact: string, index: JobFactProvenanceIndex): boolean {
  const normalized = normalizeJobFact(fact);
  if (index.normalizedText.includes(normalized)) return true;

  if (/km$/.test(normalized)) {
    const value = Number(normalized.slice(0, -2));
    const roundedToKm = !/\./.test(normalized);
    return index.distancesKm.some(
      (source) =>
        Math.abs(source - value) < 0.05 ||
        (roundedToKm && Math.floor(source) <= value && value <= Math.ceil(source)),
    );
  }

  const shift = normalized.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (shift) {
    return index.clockTimesByLine.some((times) => times.has(shift[1]) && times.has(shift[2]));
  }

  const unit = normalized.match(/元\/(时|天|月)$/)?.[1];
  if (!unit) return false;
  const values = normalized.match(/\d+(?:\.\d+)?/g) ?? [];
  if (values.length === 0) return false;
  const keys = values.map(numberKey);
  if (index.salaryNumbersByLine.some((salaries) => keys.every((key) => salaries.has(key)))) {
    return true;
  }
  if (unit === '时' && keys.every((key) => index.multipliedHourlyRates.includes(key))) return true;
  return (
    unit === '天' &&
    values.every((value) => index.hourlyRates.some((rate) => isWholeShiftWage(Number(value), rate)))
  );
}

function isWholeShiftWage(dailyWage: number, hourlyRate: number): boolean {
  if (hourlyRate <= 0) return false;
  const halfHours = (dailyWage / hourlyRate) * 2;
  return halfHours >= 2 && halfHours <= 24 && Math.abs(halfHours - Math.round(halfHours)) < 1e-6;
}

function parseSpokenTimes(line: string): string[] {
  const times: string[] = [];
  for (const match of line.matchAll(SPOKEN_TIME_PATTERN)) {
    const hour = parseChineseInt(match[2]);
    if (hour === null || hour > 24) continue;
    const minute =
      match[3] === '半'
        ? 30
        : match[4] !== undefined
          ? Number(match[4])
          : match[5] !== undefined
            ? parseChineseInt(match[5])
            : 0;
    if (minute === null || minute > 59) continue;
    const period = match[1];
    if (period && /下午|傍晚|晚|半夜/.test(period)) {
      times.push(formatClock(hour < 12 ? hour + 12 : hour, minute));
    } else if (period && /上午|早|凌晨/.test(period)) {
      times.push(formatClock(hour, minute));
    } else {
      times.push(formatClock(hour, minute));
      if (hour < 12) times.push(formatClock(hour + 12, minute));
    }
  }
  return times;
}

function parseChineseInt(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const tenIndex = raw.indexOf('十');
  if (tenIndex < 0) return raw.length === 1 ? (CN_DIGITS[raw] ?? null) : null;
  const tens = tenIndex === 0 ? 1 : CN_DIGITS[raw.slice(0, tenIndex)];
  const onesRaw = raw.slice(tenIndex + 1);
  const ones = onesRaw ? CN_DIGITS[onesRaw] : 0;
  return tens === undefined || ones === undefined ? null : tens * 10 + ones;
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function numberKey(raw: string): string {
  return String(Number(raw));
}
