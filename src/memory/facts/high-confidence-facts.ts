import type { BrandItem } from '@/sponge/sponge.types';
import { formatLocalDate } from '@infra/utils/date.util';
import {
  FALLBACK_EXTRACTION,
  type CityFact,
  type EntityExtractionResult,
  type InterviewInfo,
  type Preferences,
  type ScheduleConstraintFact,
} from '../types/session-facts.types';
import {
  DISTRICT_TO_CITY,
  LOCATION_TO_CITY,
  MUNICIPALITIES,
  NATIONAL_CITY_SUFFIX_TO_CITY,
  SUPPORTED_CITY_PREFIXES,
  matchInUncoveredSegments,
  normalizeDistrictForLookup,
  scanWhitelistKeysByLongest,
  type WhitelistScanResult,
} from './geo-mappings';
import { isLikelyRealChineseName } from './name-guard';

// ── 地理常量 ───────────────────────────────────────────────────────────────

/**
 * 城市识别词典：直辖市 + 已支持城市前缀去重后的精确匹配集合。
 * 给 scanWhitelistKeysByLongest 作为 city 维度的输入。
 */
const CITY_DICT: Record<string, true> = Object.fromEntries(
  Array.from(new Set<string>([...MUNICIPALITIES, ...SUPPORTED_CITY_PREFIXES])).map((city) => [
    city,
    true,
  ]),
);

/** 正则兜底：在白名单未覆盖区间识别"白名单外的 raw district"（不补 city）。 */
const RAW_DISTRICT_PATTERN = /([一-龥]{2,10}(?:区|县|镇|街道|新区|开发区))/g;

// ── 品牌匹配常量 ───────────────────────────────────────────────────────────

/**
 * 品牌匹配降噪词表：仅用于 buildExactMatchTokens 内的 stripBrandNoisePatterns，
 * 目的是从候选人消息中剥离求职意图词和语气词，留下纯品牌名。
 * 注意：与 LABOR_FORM_KEYWORDS 有交集，但不冲突——labor_form 提取跑在原始消息上，
 * 此清洗只在品牌匹配通道内生效。
 */
const BRAND_NOISE_PATTERNS = [
  '我想找',
  '想找',
  '我想看',
  '想看',
  '我想问',
  '想问',
  '问下',
  '看下',
  '看看',
  '了解下',
  '咨询下',
  '求职',
  '找工作',
  '兼职',
  '全职',
  '小时工',
  '寒假工',
  '暑假工',
  '临时工',
  '岗位',
  '工作',
  '品牌',
  '门店',
  '店里',
  '店',
  '有没有',
  '有吗',
  '在招吗',
  '招吗',
  '吗',
  '呀',
  '呢',
  '哈',
  '哦',
  '啊',
] as const;
const CONJUNCTION_SPLIT_REGEX = /(?:或者|和|跟|或|and|or)/;

// ── 个人信息关键词 ─────────────────────────────────────────────────────────

const EDUCATION_KEYWORDS = [
  '小学',
  '初中',
  '高中',
  '中专',
  '大专',
  '本科',
  '硕士',
  '博士',
] as const;

// ── 岗位偏好关键词 ─────────────────────────────────────────────────────────

// 平台所有岗位本身就是兼职，"兼职"/"全职"/"临时工" 不是筛选维度，不纳入高置信提取。
// 仅提取四个细分用工形式：兼职+、小时工、寒假工、暑假工。
const LABOR_FORM_KEYWORDS = ['兼职+', '小时工', '寒假工', '暑假工'] as const;
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
  '咖啡师',
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

// ── 班次共享模式 ───────────────────────────────────────────────────────────

const WORK_REST_PATTERN = /做一休一|上一休一|干一休一|做一天休一天|上一天休一天/;
const DO_REST_PATTERN = /做\s*([一二两三四五六七1-7])\s*休\s*([一二两三四五六七1-7])/;
const REJECT_NIGHT_PATTERN =
  /(?:不想上|不能上|不接受|不愿意上|不要|不做|不上).{0,3}夜班|夜班.{0,4}(?:不上|不要|不做|不接受)/;
const ONLY_SHIFT_TARGETS = ['早班', '白班', '晚班', '夜班', '周末', '工作日'] as const;
type OnlyShiftTarget = (typeof ONLY_SHIFT_TARGETS)[number];
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

export interface BrandAliasHint {
  brandName: string;
  matchedAlias: string;
  sourceText: string;
}

interface BrandCandidate {
  brandName: string;
  alias: string;
  normalized: string;
}

interface LocationSignals {
  city: CityFact | null;
  district: string[];
  location: string[];
}

/**
 * 剥离引用消息块，只保留候选人自己写的内容。
 *
 * 引用格式：`[引用 XXX：<被引用内容>]` 或行首 `引用 XXX：<内容>`。
 * 被引用内容通常是招募经理发的岗位描述，其中的年龄/班次/薪资等数值
 * 属于岗位要求，不是候选人自陈——必须在规则提取前剥离，否则所有
 * extract* 函数都会误提取引用块内的实体。
 */
function stripQuotedBlocks(message: string): string {
  return message
    .replace(/\[引用[^\]]*\]/g, '')
    .replace(/^引用\s+[^：]+：.*$/gm, '')
    .trim();
}

export function extractHighConfidenceFacts(
  userMessages: string[],
  brandData: BrandItem[],
): EntityExtractionResult | null {
  const normalizedMessages = userMessages
    .map((message) => stripQuotedBlocks(message.trim()))
    .filter(Boolean);
  if (normalizedMessages.length === 0) return null;

  const facts = cloneFallbackExtraction();
  const reasons: string[] = [];

  const aliasHints = detectBrandAliasHints(normalizedMessages, brandData);
  if (aliasHints.length > 0) {
    facts.preferences.brands = Array.from(new Set(aliasHints.map((hint) => hint.brandName)));
    reasons.push(
      ...aliasHints.map(
        (hint) =>
          `品牌别名识别：用户原话"${hint.sourceText}"命中"${hint.matchedAlias}" => "${hint.brandName}"`,
      ),
    );
  }

  for (const message of normalizedMessages) {
    const structuredName = extractStructuredName(message);
    if (structuredName && !facts.interview_info.name) {
      facts.interview_info.name = structuredName;
      reasons.push(`结构化姓名识别：${structuredName}（来源：收资表单键值对）`);
    }

    const phone = extractPhone(message);
    if (phone && !facts.interview_info.phone) {
      facts.interview_info.phone = phone;
      reasons.push(`手机号识别：${phone}`);
    }

    const age = extractAge(message);
    if (age && !facts.interview_info.age) {
      facts.interview_info.age = age;
      reasons.push(`年龄识别：${age}`);
    }

    const gender = extractGender(message);
    if (gender && !facts.interview_info.gender) {
      facts.interview_info.gender = gender;
      facts.interview_info.gender_source = 'candidate';
      reasons.push(`性别识别：${gender}`);
    }

    const studentInfo = extractStudentInfo(message);
    if (studentInfo.isStudent !== null && facts.interview_info.is_student === null) {
      facts.interview_info.is_student = studentInfo.isStudent;
      reasons.push(`学生身份识别：${studentInfo.isStudent ? '是' : '否'}`);
    }
    if (studentInfo.education && !facts.interview_info.education) {
      facts.interview_info.education = studentInfo.education;
      reasons.push(`学历识别：${studentInfo.education}`);
    } else if (!studentInfo.education) {
      const explicitEducation = extractEducation(message);
      if (explicitEducation && !facts.interview_info.education) {
        facts.interview_info.education = explicitEducation;
        reasons.push(`学历识别：${explicitEducation}`);
      }
    }

    const healthCertificate = extractHealthCertificate(message);
    if (healthCertificate && !facts.interview_info.has_health_certificate) {
      facts.interview_info.has_health_certificate = healthCertificate;
      reasons.push(`健康证识别：${healthCertificate}`);
    }

    const laborForm = extractLaborForm(message);
    if (laborForm && !facts.preferences.labor_form) {
      facts.preferences.labor_form = laborForm;
      reasons.push(`用工形式识别：${laborForm}`);
    }

    const salary = extractSalary(message);
    if (salary && !facts.preferences.salary) {
      facts.preferences.salary = salary;
      reasons.push(`薪资识别：${salary}`);
    }

    const positions = extractPositions(message);
    if (positions.length > 0) {
      facts.preferences.position = Array.from(
        new Set([...(facts.preferences.position ?? []), ...positions]),
      );
      reasons.push(`岗位识别：${positions.join('、')}`);
    }

    const schedule = extractSchedule(message);
    if (schedule && !facts.preferences.schedule) {
      facts.preferences.schedule = schedule;
      reasons.push(`班次识别：${schedule}`);
    }

    const scheduleConstraint = extractScheduleConstraintStructured(message);
    if (scheduleConstraint) {
      const merged: ScheduleConstraintFact = {
        onlyWeekends:
          scheduleConstraint.onlyWeekends ??
          facts.preferences.schedule_constraint?.onlyWeekends ??
          null,
        onlyEvenings:
          scheduleConstraint.onlyEvenings ??
          facts.preferences.schedule_constraint?.onlyEvenings ??
          null,
        onlyMornings:
          scheduleConstraint.onlyMornings ??
          facts.preferences.schedule_constraint?.onlyMornings ??
          null,
        maxDaysPerWeek:
          scheduleConstraint.maxDaysPerWeek ??
          facts.preferences.schedule_constraint?.maxDaysPerWeek ??
          null,
      };
      facts.preferences.schedule_constraint = merged;
      const labelParts: string[] = [];
      if (merged.onlyWeekends) labelParts.push('只周末');
      if (merged.onlyEvenings) labelParts.push('只晚班');
      if (merged.onlyMornings) labelParts.push('只早班');
      if (merged.maxDaysPerWeek !== null) labelParts.push(`每周≤${merged.maxDaysPerWeek}天`);
      reasons.push(`班次硬约束（结构化）：${labelParts.join('、') || '空'}`);
    }

    const availableAfter = extractAvailableAfterDate(message, formatLocalDate(new Date()));
    if (availableAfter) {
      facts.preferences.available_after = availableAfter;
      reasons.push(`未来日期硬约束：${availableAfter.date}（原话："${availableAfter.raw}"）`);
    }

    const location = extractLocation(message);
    if (location.city) {
      facts.preferences.city = location.city;
      reasons.push(
        `城市识别：${location.city.value}（证据：${location.city.evidence}，置信：${location.city.confidence}）`,
      );
    }
    if (location.district.length > 0) {
      facts.preferences.district = Array.from(
        new Set([...(facts.preferences.district ?? []), ...location.district]),
      );
      reasons.push(`区域识别：${location.district.join('、')}`);
    }
    if (location.location.length > 0) {
      facts.preferences.location = Array.from(
        new Set([...(facts.preferences.location ?? []), ...location.location]),
      );
      reasons.push(`地点识别：${location.location.join('、')}`);
    }
  }

  if (!hasAnyExtractedFact(facts)) return null;

  return {
    ...facts,
    reasoning: reasons.length > 0 ? reasons.join('\n') : '本轮前置高置信识别',
  };
}

export function detectBrandAliasHints(
  userMessages: string[],
  brandData: BrandItem[],
): BrandAliasHint[] {
  if (userMessages.length === 0 || brandData.length === 0) return [];

  const candidates = buildBrandCandidates(brandData);
  const hints: BrandAliasHint[] = [];
  const seen = new Set<string>();

  for (const message of userMessages) {
    const tokens = buildExactMatchTokens(message);
    if (tokens.length === 0) continue;

    for (const token of tokens) {
      const matched = candidates.find((candidate) => candidate.normalized === token);
      if (!matched) continue;

      const dedupeKey = `${matched.brandName}::${message}`;
      if (seen.has(dedupeKey)) continue;

      hints.push({
        brandName: matched.brandName,
        matchedAlias: matched.alias,
        sourceText: message,
      });
      seen.add(dedupeKey);
    }
  }

  return hints;
}

/**
 * 把外部数据源（如客户详情接口）补充来的性别值归一化为 '男' | '女'。
 *
 * 接受数字/字符串/英文/中文短语等常见输入形态，并保留若干边界特性：
 * - /(^|[^女])男/ 要求 '男' 前是起始或非 '女'，避免 "不男"/"非男" 被误判
 * - 同时出现 "男" 和 "女" 时视为非单值表达（如 "男女不限" / "男女皆可"），返回 null
 */
export function normalizeGenderValue(value: unknown): '男' | '女' | null {
  if (typeof value === 'number') {
    if (value === 1) return '男';
    if (value === 2) return '女';
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  if (!text) return null;
  if (text === '1') return '男';
  if (text === '2') return '女';
  if (/^(male|man)$/i.test(text)) return '男';
  if (/^(female|woman)$/i.test(text)) return '女';
  const hasMale = /男/.test(text);
  const hasStandaloneMale = /(^|[^女])男/.test(text);
  const hasFemale = /女/.test(text);
  if (hasMale && hasFemale) return null;
  if (hasStandaloneMale) return '男';
  if (hasFemale) return '女';
  return null;
}

/**
 * 把外部补充的性别合并进高置信事实对象。
 *
 * 使用浅拷贝保证不污染入参引用，并把来源标签追加到 reasoning 里，便于排障溯源。
 * 与 mergeDetectedBrands 同构，都是"补充字段→不可变合并"的合并器。
 */
export function mergeSupplementalGenderFact(
  existing: EntityExtractionResult | null,
  gender: '男' | '女',
  sourceLabel: string,
): EntityExtractionResult {
  const base: EntityExtractionResult = existing
    ? {
        ...existing,
        interview_info: { ...existing.interview_info },
        preferences: { ...existing.preferences },
      }
    : cloneFallbackExtraction();

  base.interview_info.gender = gender;
  base.interview_info.gender_source = 'system';
  const suffix = `${sourceLabel}补充性别：${gender}`;
  base.reasoning = [base.reasoning?.trim(), suffix].filter(Boolean).join('；');

  return base;
}

export function mergeDetectedBrands(
  facts: EntityExtractionResult,
  aliasHints: BrandAliasHint[],
): EntityExtractionResult {
  const detectedBrands = Array.from(new Set(aliasHints.map((hint) => hint.brandName)));
  if (detectedBrands.length === 0) return facts;

  const existingBrands = facts.preferences.brands ?? [];
  const mergedBrands = Array.from(new Set([...existingBrands, ...detectedBrands]));
  const addedBrands = mergedBrands.filter((brand) => !existingBrands.includes(brand));
  if (addedBrands.length === 0) return facts;

  const reasoningSuffix = aliasHints
    .filter((hint) => addedBrands.includes(hint.brandName))
    .map(
      (hint) =>
        `根据用户原话"${hint.sourceText}"，将别名"${hint.matchedAlias}"归一化为标准品牌"${hint.brandName}"`,
    )
    .join('；');

  return {
    ...facts,
    preferences: {
      ...facts.preferences,
      brands: mergedBrands,
    },
    reasoning: reasoningSuffix ? `${facts.reasoning}\n${reasoningSuffix}` : facts.reasoning,
  };
}

function cloneFallbackExtraction(): EntityExtractionResult {
  return {
    interview_info: { ...FALLBACK_EXTRACTION.interview_info },
    preferences: { ...FALLBACK_EXTRACTION.preferences },
    reasoning: FALLBACK_EXTRACTION.reasoning,
  };
}

function hasAnyExtractedFact(facts: EntityExtractionResult): boolean {
  return hasAnyValue(facts.interview_info) || hasAnyValue(facts.preferences);
}

function hasAnyValue(record: InterviewInfo | Preferences): boolean {
  return Object.values(record).some((value) => {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return true; // CityFact object
    return value !== '';
  });
}

/**
 * 结构化收资表单中的"姓名：XX"键值对提取。
 *
 * 与 name-guard.ts 的 hasStructuredNameSubmission 共用同一匹配逻辑，
 * 但定位不同：这里是"正向提取"（上游锚定），name-guard 是"事后救援"（下游补漏）。
 * 提取后经 isLikelyRealChineseName 校验，拦截昵称/乱码等非真名。
 */
const STRUCTURED_NAME_REGEX =
  /(?:^|[\n\r])\s*(?:姓名|名字)\s*[：:\s]\s*([^\n\r。，,！!？?]+?)(?=[\n\r]|$)/u;

export function extractStructuredName(message: string): string | null {
  const match = STRUCTURED_NAME_REGEX.exec(message);
  if (!match?.[1]) return null;
  const candidate = match[1].trim();
  if (!candidate) return null;
  return isLikelyRealChineseName(candidate) ? candidate : null;
}

function extractPhone(message: string): string | null {
  return message.match(/(?<!\d)1[3-9]\d{9}(?!\d)/)?.[0] ?? null;
}

function extractAge(message: string): string | null {
  if (/(?:要求|需要|限|须).{0,6}\d{2}\s*岁/.test(message)) return null;
  if (/\d{2}\s*[-~至到]\s*\d{2}\s*岁/.test(message)) return null;

  const structuredAge = message.match(/(?:^|[\n\r])\s*年龄\s*[：:\s]\s*(\d{2})(?=\D|$)/u);
  if (structuredAge) return structuredAge[1];

  const directAge = message.match(/(\d{2})岁/);
  if (directAge) return directAge[1];

  const currentAge = message.match(/今年(\d{2})/);
  if (currentAge) return currentAge[1];

  return null;
}

function extractGender(message: string): string | null {
  if (/(我是|本人|性别)[：: ]?(男生|男)/.test(message) || /男的/.test(message)) return '男';
  if (/(我是|本人|性别)[：: ]?(女生|女)/.test(message) || /女的/.test(message)) return '女';
  return null;
}

function extractStudentInfo(message: string): {
  isStudent: boolean | null;
  education: string | null;
} {
  if (/本科在读/.test(message)) {
    return { isStudent: true, education: '本科在读' };
  }
  if (/硕士在读|研究生在读|研一|研二|研三/.test(message)) {
    return { isStudent: true, education: '硕士在读' };
  }
  if (/博士在读|博一|博二|博三/.test(message)) {
    return { isStudent: true, education: '博士在读' };
  }
  if (/考上研究生|研究生.*录取|录取.*研究生|准研究生|待入学|准备读研|读研|上研/.test(message)) {
    return { isStudent: true, education: '硕士待入学' };
  }
  if (/我是学生|还在读|在校|在读/.test(message)) {
    return { isStudent: true, education: null };
  }
  if (/大一|大二|大三|大四/.test(message)) {
    return { isStudent: true, education: '本科在读' };
  }
  // 反向触发：候选人明确说自己已离开校园 → is_student=false
  // badcase v9mxbgiv：候选人回"社会人士，目前待岗状态"，规则只覆盖"不是学生|已毕业"导致漏判，
  // Agent 反复追问"学生还是社会人士"。需要与 LLM 抽取（session-extraction.prompt.ts）的
  // 反向触发词保持一致。
  if (
    /不是学生|已毕业|社会人士|上班族|已经工作|工作过|在职|待岗|失业|退休|全职妈妈|带娃/.test(
      message,
    )
  ) {
    return { isStudent: false, education: null };
  }
  return { isStudent: null, education: null };
}

function extractEducation(message: string): string | null {
  if (isLikelyLocationOrSchoolName(message)) return null;

  if (/本科在读/.test(message)) return '本科在读';
  if (/硕士在读|研究生在读/.test(message)) return '硕士在读';
  if (/博士在读/.test(message)) return '博士在读';

  for (const keyword of EDUCATION_KEYWORDS) {
    if (message.includes(keyword)) return keyword;
  }
  return null;
}

function isLikelyLocationOrSchoolName(message: string): boolean {
  if (message.includes('[位置分享]') || message.includes('[经纬度:')) return true;
  return /(小学部|初中部|高中部|中学部|大学城|学校|校区|学院|幼儿园|附小)/.test(message);
}

function extractHealthCertificate(message: string): string | null {
  if (/不接受办健康证|不办健康证/.test(message)) return '无且不接受办理健康证';
  if (/接受办健康证|可以办健康证|可办健康证/.test(message)) return '无但接受办理健康证';
  if (/没有(?:食品|餐饮|零售)?(?:类)?健康证|没健康证|无健康证/.test(message)) return '无';
  if (
    /健康证.{0,6}(?:不是|非)本地|(?:外地|异地).{0,3}健康证|健康证.{0,4}(?:外地|异地)/.test(message)
  ) {
    return '非本地健康证';
  }
  if (/有健康证|(?:食品|餐饮|零售)(?:类)?健康证/.test(message)) {
    return '有';
  }
  return null;
}

function extractLaborForm(message: string): string | null {
  for (const keyword of LABOR_FORM_KEYWORDS) {
    if (message.includes(keyword)) return keyword;
  }
  return null;
}

function extractSalary(message: string): string | null {
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

function extractPositions(message: string): string[] {
  return POSITION_KEYWORDS.filter((keyword) => message.includes(keyword));
}

function extractSchedule(message: string): string | null {
  const matched: string[] = [];

  for (const keyword of SCHEDULE_KEYWORDS) {
    if (message.includes(keyword)) matched.push(keyword);
  }

  const weeklyDayConstraint = extractWeeklyDayConstraint(message);
  if (weeklyDayConstraint) matched.push(weeklyDayConstraint);

  const workRestSchedule = matchWorkRestSchedule(message);
  if (workRestSchedule) matched.push(workRestSchedule);

  if (REJECT_NIGHT_PATTERN.test(message)) {
    matched.push('不上夜班');
  }

  matched.push(...matchOnlyShifts(message));

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
    new RegExp(`只(?:能|想|考虑)?[^，。！？；;]{0,8}?${shift}`).test(message),
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

/**
 * 结构化班次约束提取（Phase 3.1）。
 *
 * 与 extractSchedule 的字符串输出互补：把"做一休一/每周最多两天/只周末/只晚班"
 * 等高置信信号同时派生成 ScheduleConstraintFact 对象，便于 duliday_job_list 工具
 * 直接读取并自动带上 candidateScheduleConstraint 入参，不依赖 LLM 在多轮后还记得。
 *
 * 返回 null 表示本条消息没有可结构化的硬约束信号。
 */
function extractScheduleConstraintStructured(message: string): {
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

  const workRestDays = matchWorkRestDays(message);
  if (workRestDays !== null) result.maxDaysPerWeek = workRestDays;

  // 每周 + 任意 ≤ 15 字符 + 数字 + 天；片段需含"最多/至多/只能/只/就"等上限语义
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

/**
 * 未来日期硬约束提取（Phase 3.2，简化版）。
 *
 * 仅识别明确日期（"5月1日之后" / "5.1 之后" / "2026-05-15 之后"），
 * 解析成 YYYY-MM-DD；模糊词（"等开学" / "月底" / "下周后"）一律不识别，
 * 让 Agent handoff 转人工，避免错误抽日期。
 *
 * 返回 null 表示无可解析的明确日期信号。
 */
function extractAvailableAfterDate(
  message: string,
  today: string,
): { date: string; raw: string } | null {
  const currentYear = Number(today.slice(0, 4));

  // 2026-05-15 / 2026/05/15 + 后/之后/以后
  const fullDate = message.match(/((\d{4})[-/](\d{1,2})[-/](\d{1,2}))\s*(?:之?后|以后|起)/);
  if (fullDate?.[1]) {
    const [, , y, m, d] = fullDate;
    const date = toYyyyMmDd(Number(y), Number(m), Number(d));
    if (date && date > today) return { date, raw: fullDate[0] };
  }

  // X月Y日/号 + 后/之后/以后
  const monthDay = message.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]\s*(?:之?后|以后|起)/);
  if (monthDay?.[1] && monthDay[2]) {
    const date = toYyyyMmDd(currentYear, Number(monthDay[1]), Number(monthDay[2]));
    if (date) {
      // 若解析出的日期 ≤ 今天，往后推一年
      const finalDate =
        date > today ? date : toYyyyMmDd(currentYear + 1, Number(monthDay[1]), Number(monthDay[2]));
      if (finalDate) return { date: finalDate, raw: monthDay[0] };
    }
  }

  // M.D 之后 / M.D 以后（如"5.1之后"）
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

/**
 * 抽取地点相关字段（含高置信城市推导）。
 *
 * 设计：**白名单驱动扫描 + 正则兜底**（PR #177 之后的第二次重构）。
 *
 * 以前用"贪婪正则吃整段 → 事后清洗"的策略，每出一种新表达（"你好我在青浦区"、
 * "浦东新区航头镇"…）都要在清洗链上加一刀。本版本反过来：
 *   1. 先用白名单做最长精确匹配（city → district → location），数据驱动
 *   2. 未覆盖字符段才交给正则识别"白名单外的 raw district"，**不补 city**（留给 LLM）
 *
 * 加新支持城市/区，只改 geo-mappings 数据，不再动正则/清洗。
 */
function extractLocation(message: string): LocationSignals {
  const positionShareLocations = extractPositionShareLocations(message);

  // 三轮串联扫描，covered 区间逐轮累积，避免后轮再去消费前轮已认领的字符
  const cityScan = scanWhitelistKeysByLongest(message, CITY_DICT);
  const districtScan = scanWhitelistKeysByLongest(message, DISTRICT_TO_CITY, cityScan.covered);
  const locationScan = scanWhitelistKeysByLongest(message, LOCATION_TO_CITY, districtScan.covered);

  const city = resolveCity(message, cityScan, districtScan, locationScan);

  // district：白名单命中（归一化后） + 未覆盖区间正则兜底（白名单外，城市未知）
  const whitelistDistricts = districtScan.hits.map((hit) => normalizeDistrictForLookup(hit.key));
  const rawDistricts = matchInUncoveredSegments(
    message,
    locationScan.covered,
    RAW_DISTRICT_PATTERN,
  ).map(normalizeRawDistrict);
  const districts = Array.from(new Set([...whitelistDistricts, ...rawDistricts].filter(Boolean)));

  // location：位置分享 title/address + 白名单命中 + "XX附近/旁边" 兜底
  const whitelistLocations = locationScan.hits.map((hit) => hit.key);
  const nearbyLocations = extractNearbyLocations(message, districts);
  const locations = Array.from(
    new Set([...positionShareLocations, ...whitelistLocations, ...nearbyLocations].filter(Boolean)),
  );

  return { city, district: districts, location: locations };
}

/**
 * 综合三轮扫描结果推导 city（带 evidence）。
 *
 * 优先级：白名单 city > district 反推 > location 反推 > 通用"XX市"正则兜底。
 *
 * evidence 细分：
 *   - `municipality_compact`：直辖市开头（start=0）且紧接 district 命中（"上海浦东"）
 *   - `explicit_city`：其他 city 白名单命中或通用"XX市"匹配
 *   - `unique_district_alias`：从 district 反推（无歧义区名）
 *   - `hotspot_alias`：从 location/商圈反推
 */
function resolveCity(
  message: string,
  cityScan: WhitelistScanResult,
  districtScan: WhitelistScanResult,
  locationScan: WhitelistScanResult,
): CityFact | null {
  const cityHit = cityScan.hits[0];
  if (cityHit) {
    const isMunicipality = (MUNICIPALITIES as readonly string[]).includes(cityHit.key);
    const hasTightDistrict = districtScan.hits.some((d) => d.start === cityHit.end);
    const evidence =
      isMunicipality && cityHit.start === 0 && hasTightDistrict
        ? 'municipality_compact'
        : 'explicit_city';
    return { value: cityHit.key, confidence: 'high', evidence };
  }

  const districtHit = districtScan.hits[0];
  if (districtHit) {
    return {
      value: DISTRICT_TO_CITY[districtHit.key],
      confidence: 'high',
      evidence: 'unique_district_alias',
    };
  }

  const locationHit = locationScan.hits[0];
  if (locationHit) {
    return {
      value: LOCATION_TO_CITY[locationHit.key],
      confidence: 'high',
      evidence: 'hotspot_alias',
    };
  }

  // 全国城市名表兜底：只接受真实"XX市"行政区划名，避免"大超市/夜市"误提取。
  const nationalCityScan = scanWhitelistKeysByLongest(
    message,
    NATIONAL_CITY_SUFFIX_TO_CITY,
    locationScan.covered,
  );
  const nationalCityHit = nationalCityScan.hits[0];
  if (nationalCityHit) {
    return {
      value: NATIONAL_CITY_SUFFIX_TO_CITY[nationalCityHit.key],
      confidence: 'high',
      evidence: 'explicit_city',
    };
  }

  return null;
}

function normalizeRawDistrict(candidate: string): string {
  // 兜底场景：候选词来自"白名单未覆盖区间"。理论上不含已识别的区名，但仍可能整段
  // 被正则吃进来（如完全在白名单外的城市的区），所以复用旧版前缀剥离 + 后缀归一化
  // 作最后一层保险。
  const withoutPrefix = candidate
    .replace(/^[\u4e00-\u9fa5]{2,12}省/, '')
    .replace(/^[\u4e00-\u9fa5]{2,12}市/, '')
    .replace(/^(?:你好|您好|哈喽|嗨)/, '')
    .replace(/^(?:我在|人在|住在|我住|目前在|现在在|今天在|平时在|在)/, '');
  return normalizeDistrictForLookup(withoutPrefix);
}

function extractNearbyLocations(message: string, districts: string[]): string[] {
  const nearbyMatch = message.match(
    /(?:我在|人在|在|住在)?([\u4e00-\u9fa5A-Za-z0-9]{2,20})(?:附近|旁边)/,
  );
  if (!nearbyMatch?.[1]) return [];

  const location = nearbyMatch[1].trim();
  if (!location) return [];
  if (districts.some((district) => location.includes(district))) return [];
  return [location];
}

function extractPositionShareLocations(message: string): string[] {
  if (!message.includes('[位置分享]')) return [];

  const locations: string[] = [];
  const title = message.match(/\[位置分享\]\s*([^（\[]+)/)?.[1]?.trim();
  if (title) locations.push(title);

  const address = message.match(/（([^）]+)）/)?.[1]?.trim();
  if (address) locations.push(address);

  return Array.from(new Set(locations.filter(Boolean)));
}

function buildBrandCandidates(brandData: BrandItem[]): BrandCandidate[] {
  return brandData
    .flatMap((brand) => [brand.name, ...(brand.aliases ?? [])].map((alias) => ({ brand, alias })))
    .map(({ brand, alias }) => ({
      brandName: brand.name,
      alias,
      normalized: normalizeForBrandMatch(alias),
    }))
    .filter((candidate) => candidate.normalized.length > 0)
    .sort((a, b) => b.normalized.length - a.normalized.length);
}

function buildExactMatchTokens(message: string): string[] {
  const normalized = normalizeForBrandMatch(message);
  if (!normalized) return [];

  const stripped = stripBrandNoisePatterns(normalized);
  const tokens = new Set<string>();

  if (normalized) tokens.add(normalized);
  if (stripped) tokens.add(stripped);

  for (const token of stripped.split(CONJUNCTION_SPLIT_REGEX)) {
    if (token) tokens.add(token);
  }

  return Array.from(tokens).filter(Boolean);
}

function stripBrandNoisePatterns(normalizedText: string): string {
  let output = normalizedText;
  for (const pattern of BRAND_NOISE_PATTERNS) {
    output = output.replace(new RegExp(pattern, 'g'), '');
  }
  return output;
}

function normalizeForBrandMatch(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}
