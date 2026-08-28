import { scanGeoSignalsFromText } from '@resolution/geo';
import { decideLaborFormIntent } from '@resolution/labor-form';
import { extractLocationShareLabels } from '@resolution/signal/markers';
import type { TurnHintCity } from '../projection.types';

const POSITION_KEYWORDS = [
  '服务员',
  '收银员',
  '店员',
  '营业员',
  '导购',
  '理货员',
  '分拣员',
  '分拣',
  '打包',
  '配送员',
  '骑手',
  // 不收录 "咖啡师"：咖啡是品类/行业词，不能据此窄化成工种。
  '厨工',
  '洗碗工',
  '保洁',
  '仓管',
] as const;

const SCHEDULE_KEYWORDS = [
  '周末',
  '工作日',
  '早班',
  '晚班',
  '夜班',
  '白班',
  '全天',
  '上午',
  '下午',
  '周一到周五',
  '周一到周日',
] as const;

const WORK_REST_PATTERN = /做一休一|上一休一|干一休一|做一天休一天|上一天休一天/;
const DO_REST_PATTERN = /做\s*([一二两三四五六七1-7])\s*休\s*([一二两三四五六七1-7])/;
const REJECT_NIGHT_PATTERN =
  /(?:不想上|不能上|不接受|不愿意上|不要|不做|不上).{0,3}夜班|夜班.{0,4}(?:不上|不要|不做|不接受)/;
const ONLY_SHIFT_TARGETS = ['早班', '白班', '晚班', '夜班', '周末', '工作日'] as const;
type OnlyShiftTarget = (typeof ONLY_SHIFT_TARGETS)[number];

// "周末"的同义面：候选人常说具体的"周六/周日/星期六/礼拜天"而不说"周末"。
const WEEKEND_WORD_FRAGMENT = '(?:周末|(?:周|星期|礼拜)[六日天])';
const ONLY_SHIFT_TARGET_FRAGMENTS: Record<OnlyShiftTarget, string> = {
  早班: '早班',
  白班: '白班',
  晚班: '晚班',
  夜班: '夜班',
  周末: WEEKEND_WORD_FRAGMENT,
  工作日: '工作日',
};
const WEEKEND_SEEK_PATTERN = new RegExp(
  `(?:找|想做|想找|做|干|要)[^，。！？；;]{0,10}?${WEEKEND_WORD_FRAGMENT}[^，。！？；;]{0,6}?的?(?:兼职|工作|活儿?|岗位?|班)` +
    `|${WEEKEND_WORD_FRAGMENT}[^，。！？；;]{0,4}?(?:有没有|有什么|有啥|能做|可以做)[^，。！？；;]{0,8}?(?:兼职|工作|活儿?|岗位?|班)`,
);
const WEEKLY_DAY_PATTERN = /(?:每周|一周)([^，。！？；;]{0,15}?)([一二两三四五六七0-7])\s*天/;
const CHINESE_NUM_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
};

interface LocationSignals {
  city: TurnHintCity | null;
  district: string[];
  location: string[];
}

export function extractLaborForm(message: string): string | null {
  const intent = decideLaborFormIntent(message);
  return intent.kind === 'set' ? intent.value : null;
}

export function extractSalary(message: string): string | null {
  const patterns = [
    /(时薪\s*\d+(?:\.\d+)?(?:\s*[-~到]\s*\d+(?:\.\d+)?)?)/,
    /(\d+(?:\.\d+)?\s*元\s*\/\s*(?:时|小时|天|月))/,
    /((?:月薪|日薪)\s*\d+(?:\s*[-~到]\s*\d+)?)/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+/g, '');
  }

  const rangeMatch = message.match(
    /((?:薪资|工资|月薪|时薪|日薪|收入|待遇|报酬)?\s*\d{3,5}\s*[-~到]\s*\d{3,5}\s*(?:(?:元|块)(?:\s*\/\s*(?:月|天|时|小时))?|\/\s*(?:月|天|时|小时))?)/,
  );
  if (rangeMatch?.[1]) {
    const normalized = rangeMatch[1].replace(/\s+/g, '');
    const hasSemanticPrefix = /^(?:薪资|工资|月薪|时薪|日薪|收入|待遇|报酬)/.test(normalized);
    const hasUnitSuffix = /(?:元|块|\/(?:月|天|时|小时))$/.test(normalized);
    if (hasSemanticPrefix || hasUnitSuffix) return normalized;
  }
  return null;
}

export function extractPositions(message: string): string[] {
  return POSITION_KEYWORDS.filter((keyword) => message.includes(keyword));
}

export function extractSchedule(message: string): string | null {
  const matched: string[] = [];

  for (const keyword of SCHEDULE_KEYWORDS) {
    if (message.includes(keyword)) matched.push(keyword);
  }

  const weeklyDayConstraint = extractWeeklyDayConstraint(message);
  if (weeklyDayConstraint) matched.push(weeklyDayConstraint);

  const workRestSchedule = matchWorkRestSchedule(message);
  if (workRestSchedule) matched.push(workRestSchedule);

  if (REJECT_NIGHT_PATTERN.test(message)) matched.push('不上夜班');
  matched.push(...matchOnlyShifts(message));
  if (WEEKEND_SEEK_PATTERN.test(message)) matched.push('周末');

  const timeRange = extractTimeRange(message);
  if (timeRange) matched.push(timeRange);

  if (
    /下班后|下班以后|下班之后|晚[上间]\s*\d{1,2}\s*(?:点|:|：)|[一二三四五六七八九十\d]{1,3}\s*点(?:半)?(?:才|才能)?下班/.test(
      message,
    )
  ) {
    matched.push('下班后');
  }

  return matched.length > 0 ? Array.from(new Set(matched)).join('、') : null;
}

function extractWeeklyDayConstraint(message: string): string | null {
  const signal = matchWeeklyDayConstraint(message);
  if (!signal) return null;
  const qualifier = signal.isUpperBound ? '最多' : '';
  return `每周${qualifier}${signal.token}天`;
}

function parseChineseOrArabicNumber(token: string): number | null {
  if (CHINESE_NUM_MAP[token] != null) return CHINESE_NUM_MAP[token];
  const num = parseInt(token, 10);
  return Number.isFinite(num) && num >= 1 && num <= 7 ? num : null;
}

function matchOnlyShiftTargets(message: string): OnlyShiftTarget[] {
  return ONLY_SHIFT_TARGETS.filter((shift) =>
    new RegExp(`只(?:能|想|考虑)?[^，。！？；;]{0,8}?${ONLY_SHIFT_TARGET_FRAGMENTS[shift]}`).test(
      message,
    ),
  );
}

function matchOnlyShifts(message: string): string[] {
  return matchOnlyShiftTargets(message).map((shift) => `只${shift}`);
}

function matchWorkRestDays(message: string): number | null {
  return matchWorkRestSignal(message)?.days ?? null;
}

function matchWorkRestSchedule(message: string): string | null {
  return matchWorkRestSignal(message)?.label ?? null;
}

function matchWorkRestSignal(message: string): { days: number; label: string } | null {
  if (WORK_REST_PATTERN.test(message)) return { days: 1, label: '做一休一' };

  const doRestMatch = message.match(DO_REST_PATTERN);
  if (!doRestMatch?.[1]) return null;
  const days = parseChineseOrArabicNumber(doRestMatch[1]);
  if (days === null) return null;
  return { days, label: doRestMatch[0].replace(/\s+/g, '') };
}

function matchWeeklyDayConstraint(message: string): {
  token: string;
  value: number | null;
  isUpperBound: boolean;
} | null {
  const match = message.match(WEEKLY_DAY_PATTERN);
  if (!match?.[2]) return null;
  const qualifierFragment = match[1] ?? '';
  return {
    token: match[2],
    value: parseChineseOrArabicNumber(match[2]),
    isUpperBound: /最多|至多|只能|只|就/.test(qualifierFragment),
  };
}

export function extractScheduleConstraintStructured(message: string): {
  onlyWeekends: boolean | null;
  onlyEvenings: boolean | null;
  onlyMornings: boolean | null;
  maxDaysPerWeek: number | null;
} | null {
  const result = {
    onlyWeekends: null as boolean | null,
    onlyEvenings: null as boolean | null,
    onlyMornings: null as boolean | null,
    maxDaysPerWeek: null as number | null,
  };

  const onlyShiftTargets = matchOnlyShiftTargets(message);
  if (onlyShiftTargets.includes('周末')) result.onlyWeekends = true;
  if (onlyShiftTargets.some((shift) => shift === '晚班' || shift === '夜班')) {
    result.onlyEvenings = true;
  }
  if (onlyShiftTargets.includes('早班')) result.onlyMornings = true;
  if (result.onlyWeekends === null && WEEKEND_SEEK_PATTERN.test(message)) {
    result.onlyWeekends = true;
  }

  const workRestDays = matchWorkRestDays(message);
  if (workRestDays !== null) result.maxDaysPerWeek = workRestDays;
  if (result.maxDaysPerWeek === null) {
    const weeklyDayConstraint = matchWeeklyDayConstraint(message);
    if (weeklyDayConstraint?.isUpperBound && weeklyDayConstraint.value !== null) {
      result.maxDaysPerWeek = weeklyDayConstraint.value;
    }
  }

  const hasAny =
    result.onlyWeekends !== null ||
    result.onlyEvenings !== null ||
    result.onlyMornings !== null ||
    result.maxDaysPerWeek !== null;
  return hasAny ? result : null;
}

export function extractAvailableAfterDate(
  message: string,
  today: string,
): { date: string; raw: string } | null {
  const currentYear = Number(today.slice(0, 4));

  const fullDate = message.match(/((\d{4})[-/](\d{1,2})[-/](\d{1,2}))\s*(?:之?后|以后|起)/);
  if (fullDate?.[1]) {
    const [, , y, m, d] = fullDate;
    const date = toYyyyMmDd(Number(y), Number(m), Number(d));
    if (date && date > today) return { date, raw: fullDate[0] };
  }

  const monthDay = message.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]\s*(?:之?后|以后|起)/);
  if (monthDay?.[1] && monthDay[2]) {
    const date = toYyyyMmDd(currentYear, Number(monthDay[1]), Number(monthDay[2]));
    if (date) {
      const finalDate =
        date > today ? date : toYyyyMmDd(currentYear + 1, Number(monthDay[1]), Number(monthDay[2]));
      if (finalDate) return { date: finalDate, raw: monthDay[0] };
    }
  }

  const dotMatch = message.match(/(\d{1,2})\.(\d{1,2})\s*(?:之?后|以后|起)/);
  if (dotMatch?.[1] && dotMatch[2]) {
    const date = toYyyyMmDd(currentYear, Number(dotMatch[1]), Number(dotMatch[2]));
    if (date) {
      const finalDate =
        date > today ? date : toYyyyMmDd(currentYear + 1, Number(dotMatch[1]), Number(dotMatch[2]));
      if (finalDate) return { date: finalDate, raw: dotMatch[0] };
    }
  }

  return null;
}

function toYyyyMmDd(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() + 1 !== m || utc.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function extractTimeRange(message: string): string | null {
  const match = message.match(
    /((?:早上|上午|下午|晚上|晚间)?\s*[0-9一二三四五六七八九十]{1,3}\s*(?:点|:|：)(?:半|\d{2})?\s*(?:到|至|-|~)\s*[0-9一二三四五六七八九十]{1,3}\s*(?:点|:|：)?(?:半|\d{2})?)/,
  );
  return match?.[1]?.replace(/\s+/g, '') ?? null;
}

export function extractLocation(message: string): LocationSignals {
  const positionShareLocations = extractLocationShareLabels(message);
  const geoScan = scanGeoSignalsFromText(message);
  const city: TurnHintCity | null = geoScan.city
    ? { value: geoScan.city.value, confidence: 'high', evidence: geoScan.city.evidence }
    : null;
  const districts = geoScan.districts;
  const nearbyLocations = extractNearbyLocations(message, districts);
  const locations = Array.from(
    new Set([...positionShareLocations, ...geoScan.locations, ...nearbyLocations].filter(Boolean)),
  );
  return { city, district: districts, location: locations };
}

const NEARBY_LOCATION_STOPWORDS = new Set([
  '公司',
  '学校',
  '单位',
  '宿舍',
  '小区',
  '我家',
  '你家',
  '我们家',
  '这边',
  '那边',
  '这里',
  '那里',
  '门店',
  '店里',
  '住的地方',
  '上班的地方',
]);

const NON_LOCATION_NEARBY_ACTION_TAIL_PATTERN =
  /(?:编|找|查|搜|看|推荐|介绍|选|挑)(?:一|两|几)?(?:个|家|些|下)?$/u;

function normalizeNearbyLocationCandidate(candidate: string): string | null {
  if (/^(?:找|查|搜|看)(?:一?下)?(?:我|我家|这边|这里|那边|那里)$/u.test(candidate)) {
    return null;
  }

  const delegatedActionPrefix =
    /^(?:(?:请|麻烦)(?:你)?(?:帮|替|给)|(?:帮|替|给))(?:我)?(?:查询|搜索|检索|搜寻|查找|推荐|介绍|查|搜|找|看|选|挑)(?:一?下)?/u;
  const explicitIntentPrefix =
    /^(?:直接|随便|我(?:想|要|想要))(?:查询|搜索|检索|搜寻|查找|推荐|介绍|查|搜|找|看|编|选|挑)(?:一?下)?/u;
  const unambiguousActionPrefix = /^(?:查询|搜索|检索|搜寻|查找|查一下|搜一下|找一下)/u;

  let normalized = candidate;
  let removedActionPrefix = false;
  for (const pattern of [delegatedActionPrefix, explicitIntentPrefix, unambiguousActionPrefix]) {
    const next = normalized.replace(pattern, '');
    if (next === normalized) continue;
    normalized = next;
    removedActionPrefix = true;
    break;
  }

  if (!removedActionPrefix) return candidate;
  normalized = normalized
    .replace(/^(?:一?下)?(?:我|我家|这边|这里|那边|那里)?(?:一|两|几)?(?:个|家|些)?/u, '')
    .trim();
  return normalized || null;
}

function extractNearbyLocations(message: string, districts: string[]): string[] {
  const nearbyMatch = message.match(
    /(?:我在|人在|在|住在)?([\u4e00-\u9fa5A-Za-z0-9]{2,20})(?:附近|旁边)/,
  );
  if (!nearbyMatch?.[1]) return [];

  const location = normalizeNearbyLocationCandidate(nearbyMatch[1].trim());
  if (!location) return [];
  if (NEARBY_LOCATION_STOPWORDS.has(location)) return [];
  if ([...NEARBY_LOCATION_STOPWORDS].some((word) => location.endsWith(word))) return [];
  if (NON_LOCATION_NEARBY_ACTION_TAIL_PATTERN.test(location)) return [];
  if (districts.some((district) => location.includes(district))) return [];
  return [location];
}
