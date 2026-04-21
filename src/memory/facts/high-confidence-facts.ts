import type { BrandItem } from '@/sponge/sponge.types';
import {
  FALLBACK_EXTRACTION,
  type CityFact,
  type EntityExtractionResult,
  type InterviewInfo,
  type Preferences,
} from '../types/session-facts.types';
import {
  DISTRICT_TO_CITY,
  LOCATION_TO_CITY,
  MUNICIPALITIES,
  SUPPORTED_CITY_PREFIXES,
  normalizeCityName,
  normalizeDistrictForLookup,
} from './geo-mappings';

const LABOR_FORM_KEYWORDS = ['兼职', '全职', '小时工', '寒假工', '暑假工', '临时工'] as const;
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
const GENERIC_QUERY_PATTERNS = [
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
const CONJUNCTION_SPLIT_REGEX = /(和|跟|或|或者|and|or)/;

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

export function extractHighConfidenceFacts(
  userMessages: string[],
  brandData: BrandItem[],
): EntityExtractionResult | null {
  const normalizedMessages = userMessages.map((message) => message.trim()).filter(Boolean);
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
    const phone = extractPhone(message);
    if (phone) {
      facts.interview_info.phone = phone;
      reasons.push(`手机号识别：${phone}`);
    }

    const age = extractAge(message);
    if (age) {
      facts.interview_info.age = age;
      reasons.push(`年龄识别：${age}`);
    }

    const gender = extractGender(message);
    if (gender) {
      facts.interview_info.gender = gender;
      reasons.push(`性别识别：${gender}`);
    }

    const studentInfo = extractStudentInfo(message);
    if (studentInfo.isStudent !== null) {
      facts.interview_info.is_student = studentInfo.isStudent;
      reasons.push(`学生身份识别：${studentInfo.isStudent ? '是' : '否'}`);
    }
    if (studentInfo.education) {
      facts.interview_info.education = studentInfo.education;
      reasons.push(`学历识别：${studentInfo.education}`);
    }

    const explicitEducation = extractEducation(message);
    if (explicitEducation) {
      facts.interview_info.education = explicitEducation;
      reasons.push(`学历识别：${explicitEducation}`);
    }

    const healthCertificate = extractHealthCertificate(message);
    if (healthCertificate) {
      facts.interview_info.has_health_certificate = healthCertificate;
      reasons.push(`健康证识别：${healthCertificate}`);
    }

    const laborForm = extractLaborForm(message);
    if (laborForm) {
      facts.preferences.labor_form = laborForm;
      reasons.push(`用工形式识别：${laborForm}`);
    }

    const salary = extractSalary(message);
    if (salary) {
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
    if (schedule) {
      facts.preferences.schedule = schedule;
      reasons.push(`班次识别：${schedule}`);
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
 * - 结果是 "处女男" 会先命中 '女' 分支（已在测试里 pin 住行为）
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
  if (/(^|[^女])男/.test(text)) return '男';
  if (/女/.test(text)) return '女';
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

function extractPhone(message: string): string | null {
  return message.match(/1[3-9]\d{9}/)?.[0] ?? null;
}

function extractAge(message: string): string | null {
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
  if (/我是学生|还在读|在校|在读/.test(message)) {
    return { isStudent: true, education: null };
  }
  if (/大一|大二|大三|大四/.test(message)) {
    return { isStudent: true, education: '本科在读' };
  }
  if (/研一|研二|研三/.test(message)) {
    return { isStudent: true, education: '硕士在读' };
  }
  if (/不是学生|已毕业/.test(message)) {
    return { isStudent: false, education: null };
  }
  return { isStudent: null, education: null };
}

function extractEducation(message: string): string | null {
  for (const keyword of EDUCATION_KEYWORDS) {
    if (message.includes(keyword)) return keyword;
  }
  return null;
}

function extractHealthCertificate(message: string): string | null {
  if (/有健康证/.test(message)) return '有';
  if (/没有健康证|没健康证|无健康证/.test(message)) return '无';
  if (/接受办健康证|可以办健康证|可办健康证/.test(message)) return '无但接受办理健康证';
  if (/不接受办健康证|不办健康证/.test(message)) return '无且不接受办理健康证';
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
    /(\d{3,5}\s*[-~到]\s*\d{3,5})/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].replace(/\s+/g, '');
  }
  return null;
}

function extractPositions(message: string): string[] {
  return POSITION_KEYWORDS.filter((keyword) => message.includes(keyword));
}

function extractSchedule(message: string): string | null {
  const matched = SCHEDULE_KEYWORDS.filter((keyword) => message.includes(keyword));
  return matched.length > 0 ? Array.from(new Set(matched)).join('、') : null;
}

/**
 * 抽取地点相关字段（含高置信城市推导）。
 *
 * 依次尝试：
 *   1. 直辖市紧凑表达（"上海浦东"）→ city + district
 *   2. 显式城市（"北京/上海/武汉…"）→ city
 *   3. 区名唯一映射（"徐汇"→上海）→ city（+ district）
 *   4. 热门地点/商圈映射（"陆家嘴"→上海）→ city（+ location）
 *   5. 区名兜底（显式"XX区"但映射表没覆盖）→ district 列表
 *   6. 地标兜底（"XX附近"）→ location 列表
 *
 * city 一定输出 CityFact 对象（含 evidence）。
 */
function extractLocation(message: string): LocationSignals {
  const compact = extractMunicipalityCompact(message);
  if (compact) return compact;

  const explicitCity = extractExplicitCity(message);
  if (explicitCity) {
    return {
      city: { value: explicitCity, confidence: 'high', evidence: 'explicit_city' },
      district: [],
      location: [],
    };
  }

  const candidate = normalizeLocationCandidate(message);
  if (candidate) {
    const districtCity = resolveCityFromDistrict(candidate);
    if (districtCity) {
      return {
        city: { value: districtCity, confidence: 'high', evidence: 'unique_district_alias' },
        district: [candidate],
        location: [],
      };
    }

    const hotspotCity = resolveCityFromLocation(candidate);
    if (hotspotCity) {
      return {
        city: { value: hotspotCity, confidence: 'high', evidence: 'hotspot_alias' },
        district: [],
        location: [candidate],
      };
    }
  }

  const explicitDistricts = extractExplicitDistricts(message);
  const explicitLocations = extractExplicitLocations(message, explicitDistricts);
  const inferredCity = resolveCityFromAny(explicitDistricts, explicitLocations);

  return {
    city: inferredCity,
    district: explicitDistricts,
    location: explicitLocations,
  };
}

function extractMunicipalityCompact(message: string): LocationSignals | null {
  const normalized = message.replace(/\s+/g, '');
  const firstSegment = normalized.split(/[，,。；;]/)[0] ?? normalized;

  for (const city of MUNICIPALITIES) {
    if (!firstSegment.startsWith(city)) continue;

    const remainder = firstSegment.slice(city.length);
    if (!remainder) {
      return {
        city: { value: city, confidence: 'high', evidence: 'municipality_compact' },
        district: [],
        location: [],
      };
    }

    const compactDistrict = remainder.match(/^([\u4e00-\u9fa5]{2,6})(区|县|镇)?$/);
    if (compactDistrict) {
      return {
        city: { value: city, confidence: 'high', evidence: 'municipality_compact' },
        district: [normalizeDistrictForLookup(compactDistrict[1])],
        location: [],
      };
    }

    const explicitDistrict = remainder.match(
      /^([\u4e00-\u9fa5]{2,8}(?:区|县|镇|街道|新区|开发区))/,
    );
    if (explicitDistrict) {
      return {
        city: { value: city, confidence: 'high', evidence: 'municipality_compact' },
        district: [normalizeDistrictForLookup(explicitDistrict[1])],
        location: [],
      };
    }

    return {
      city: { value: city, confidence: 'high', evidence: 'municipality_compact' },
      district: [],
      location: [],
    };
  }

  return null;
}

function extractExplicitCity(message: string): string | null {
  const normalized = message.replace(/\s+/g, '');
  const firstSegment = normalized.split(/[，,。；;]/)[0] ?? normalized;

  for (const city of SUPPORTED_CITY_PREFIXES) {
    if (firstSegment.startsWith(city)) return city;
  }

  const municipalityMatch = message.match(/(北京|上海|天津|重庆)(?:市)?/);
  if (municipalityMatch) return municipalityMatch[1];

  const genericCityMatch = message.match(/([\u4e00-\u9fa5]{2,8})市/);
  if (genericCityMatch?.[1]) return normalizeCityName(genericCityMatch[1]);

  return null;
}

function extractExplicitDistricts(message: string): string[] {
  const districts = Array.from(
    message.matchAll(/([\u4e00-\u9fa5]{2,10}(?:区|县|镇|街道|新区|开发区))/g),
  ).map((match) => normalizeDistrictForLookup(match[1]));

  return Array.from(new Set(districts.filter(Boolean)));
}

function extractExplicitLocations(message: string, districts: string[]): string[] {
  const nearbyMatch = message.match(
    /(?:我在|人在|在|住在)?([\u4e00-\u9fa5A-Za-z0-9]{2,20})(?:附近|旁边)/,
  );
  if (!nearbyMatch?.[1]) return [];

  const location = nearbyMatch[1].trim();
  if (!location) return [];
  if (districts.some((district) => location.includes(district))) return [];
  return [location];
}

function resolveCityFromDistrict(candidate: string): string | null {
  const normalized = normalizeDistrictForLookup(candidate);
  return DISTRICT_TO_CITY[candidate] ?? DISTRICT_TO_CITY[normalized] ?? null;
}

function resolveCityFromLocation(candidate: string): string | null {
  const normalized = candidate.replace(/\s+/g, '');
  return LOCATION_TO_CITY[candidate] ?? LOCATION_TO_CITY[normalized] ?? null;
}

function resolveCityFromAny(districts: string[], locations: string[]): CityFact | null {
  for (const district of districts) {
    const city = resolveCityFromDistrict(district);
    if (city) {
      return { value: city, confidence: 'high', evidence: 'unique_district_alias' };
    }
  }
  for (const location of locations) {
    const city = resolveCityFromLocation(location);
    if (city) {
      return { value: city, confidence: 'high', evidence: 'hotspot_alias' };
    }
  }
  return null;
}

function normalizeLocationCandidate(message: string): string {
  return message
    .replace(/\s+/g, '')
    .split(/[，,。；;]/)[0]
    .replace(/^(我在|人在|在|住在)/, '')
    .replace(/(有店招吗|有岗位吗|有店吗|有没有|有吗|招吗|在招吗|行吗|呢|呀|哈|吧)$/g, '')
    .replace(/(附近|旁边|这边|那边|周边)$/g, '')
    .replace(/(找工作|工作|岗位|门店|店招)$/g, '')
    .trim();
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

  const stripped = stripGenericQueryText(normalized);
  const tokens = new Set<string>();

  if (normalized) tokens.add(normalized);
  if (stripped) tokens.add(stripped);

  for (const token of stripped.split(CONJUNCTION_SPLIT_REGEX)) {
    if (token) tokens.add(token);
  }

  return Array.from(tokens).filter(Boolean);
}

function stripGenericQueryText(normalizedText: string): string {
  let output = normalizedText;
  for (const pattern of GENERIC_QUERY_PATTERNS) {
    output = output.replace(new RegExp(pattern, 'g'), '');
  }
  return output;
}

function normalizeForBrandMatch(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}
