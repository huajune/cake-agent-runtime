import type { BrandItem } from '@/sponge/sponge.types';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import { buildBrandCatalogIndex } from '@resolution/brand/catalog-index';
import { buildExactMatchTokens, normalizeForBrandMatch } from '@resolution/brand/brand-normalize';
import { formatLocalDate } from '@infra/utils/date.util';
import {
  FALLBACK_EXTRACTION,
  type CityFact,
  type CityFactEvidence,
  type EntityExtractionResult,
  type HighConfidenceInterviewInfo,
  type HighConfidencePreferences,
  type HighConfidenceFacts,
  type HighConfidenceValue,
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
import { decideLaborFormIntent } from './labor-form';

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

// 平台同时有全职和兼职岗位，用工形式是筛选维度。具体的偏好/否定/岗位核对语义
// 统一由 labor-form.ts 的三态解析器处理，避免关键词裸匹配误开或误清硬约束。
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
  // 不收录 "咖啡师"：咖啡是品类/行业词（见 BRAND_CATEGORIES），用户说咖啡指的是咖啡类品牌，
  // 不应被识别成 "咖啡师" 工种再窄化成 jobCategoryList。
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
// "周末"的同义面：候选人常说具体的"周六/周日/星期六/礼拜天"而不说"周末"
// （badcase batch_6a4e430dce406a6aee7a3421：候选人"帮我找黄浦区周六嘛兼职"，
// 词表只有"周末"导致班次约束整轮丢失，模型反手把"七点才下班"译成只晚班）。
const WEEKEND_WORD_FRAGMENT = '(?:周末|(?:周|星期|礼拜)[六日天])';
const ONLY_SHIFT_TARGET_FRAGMENTS: Record<OnlyShiftTarget, string> = {
  早班: '早班',
  白班: '白班',
  晚班: '晚班',
  夜班: '夜班',
  周末: WEEKEND_WORD_FRAGMENT,
  工作日: '工作日',
};
// 求职意图里点名周末/周六日（"帮我找黄浦区周六嘛兼职"/"周末有没有活"）：
// 没有"只"字也构成周末可用性约束——全周强排班岗位对这类候选人不可行。
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

const CITY_FACT_EVIDENCES = new Set<CityFactEvidence>([
  'municipality_compact',
  'explicit_city',
  'unique_district_alias',
  'hotspot_alias',
]);

export interface BrandAliasHint {
  brandName: string;
  matchedAlias: string;
  sourceText: string;
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
 * extract* 函数都会误提取引用块内的实体（品牌解析同理：引用块里的品牌是经理的话）。
 */
export function stripQuotedBlocks(message: string): string {
  return message
    .replace(/\[引用[^\]]*\]/g, '')
    .replace(/^引用\s+[^：]+：.*$/gm, '')
    .trim();
}

// ── per-field 提取器注册表 ───────────────────────────────────────────────────

type FieldGroup = 'interview_info' | 'preferences';

/**
 * 单字段提取器声明（无字段间联动）。
 *
 * 设计目标：把"提取函数 → 主循环八股 → 各处镜像清单"的六处散布收敛到一处。
 * 新增一个普通字段只需在 FIELD_EXTRACTORS 追加一项，主循环、字段完备性校验
 * 自动覆盖；带联动/自定义合并的字段（gender、is_student、schedule_constraint、
 * city/district/location、brands、available_after）不强塞进来，保留在循环内手写。
 *
 * merge 语义：
 *   - 'first-scalar'：先到先得，已有非空值则忽略本条（name/phone/age/... 等）
 *   - 'last-scalar' ：后到覆盖，仅用于需跟随候选人最新明确表达的 labor_form
 *   - 'union-array' ：累积去重，每条命中都并入已有数组（position 等）
 */
interface FieldExtractorBase {
  group: FieldGroup;
  field: string;
  /** evidence 文案（入库到字段元数据，服务排障）。 */
  evidence: (value: string) => string;
  /** reasoning 文案（拼进对外 reasoning 串）；缺省与 evidence 同文。 */
  reason?: (value: string) => string;
}

interface ScalarFieldExtractor extends FieldExtractorBase {
  merge: 'first-scalar' | 'last-scalar';
  extract: (message: string) => string | null;
}

interface ArrayFieldExtractor extends FieldExtractorBase {
  merge: 'union-array';
  /** 数组提取器：evidence/reason 接收原始命中片段（join('、') 后），merge 内部累积去重。 */
  extract: (message: string) => string[];
}

type FieldExtractor = ScalarFieldExtractor | ArrayFieldExtractor;

const FIELD_EXTRACTORS: FieldExtractor[] = [
  {
    group: 'interview_info',
    field: 'name',
    merge: 'first-scalar',
    extract: extractStructuredName,
    evidence: (value) => `结构化姓名识别：${value}`,
    reason: (value) => `结构化姓名识别：${value}（来源：收资表单键值对）`,
  },
  {
    group: 'interview_info',
    field: 'phone',
    merge: 'first-scalar',
    extract: extractPhone,
    evidence: (value) => `手机号识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'age',
    merge: 'first-scalar',
    extract: extractAge,
    evidence: (value) => `年龄识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'has_health_certificate',
    // 证件状态会随候选人补充意愿而演进：旧“无”必须能被最新“愿意办理”覆盖，
    // 最新明确拒绝也必须反向覆盖旧承诺。
    merge: 'last-scalar',
    extract: extractHealthCertificate,
    evidence: (value) => `健康证识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'experience',
    merge: 'first-scalar',
    extract: extractExperience,
    evidence: (value) => `工作经历识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'upload_resume',
    merge: 'first-scalar',
    extract: extractUploadResume,
    evidence: (value) => `简历附件识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'height',
    merge: 'first-scalar',
    extract: extractHeight,
    evidence: (value) => `身高识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'weight',
    merge: 'first-scalar',
    extract: extractWeight,
    evidence: (value) => `体重识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'household_register_province',
    merge: 'first-scalar',
    extract: extractHouseholdRegisterProvince,
    evidence: (value) => `户籍识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'labor_form',
    merge: 'last-scalar',
    extract: extractLaborForm,
    evidence: (value) => `用工形式识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'salary',
    merge: 'first-scalar',
    extract: extractSalary,
    evidence: (value) => `薪资识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'schedule',
    merge: 'first-scalar',
    extract: extractSchedule,
    evidence: (value) => `班次识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'position',
    merge: 'union-array',
    extract: extractPositions,
    evidence: (value) => `岗位识别：${value}`,
  },
];

/** 注册表声明的字段清单：供下游镜像清单做编译期/测试期完备性校验。 */
export const REGISTRY_FIELD_PATHS: readonly string[] = FIELD_EXTRACTORS.map(
  (extractor) => `${extractor.group}.${extractor.field}`,
);

function applyFieldExtractor(
  extractor: FieldExtractor,
  message: string,
  facts: HighConfidenceFacts,
  reasons: string[],
): void {
  const group = facts[extractor.group] as unknown as Record<
    string,
    HighConfidenceValue<unknown> | null
  >;
  const toReason = extractor.reason ?? extractor.evidence;

  if (extractor.merge !== 'union-array') {
    if (extractor.field === 'labor_form') {
      const intent = decideLaborFormIntent(message);
      if (intent.kind === 'ignore') return;
      if (intent.kind === 'clear') {
        const current = unwrapHighConfidenceValue(group[extractor.field]) as string | null;
        if (current && intent.clearedValues.some((value) => value === current)) {
          group[extractor.field] = null;
        }
        return;
      }
    }
    const value = extractor.extract(message);
    if (!value || (extractor.merge === 'first-scalar' && group[extractor.field])) return;
    group[extractor.field] = ruleValue(value, { evidence: extractor.evidence(value) });
    reasons.push(toReason(value));
    return;
  }

  // union-array：每条命中并入已有数组并去重
  const values = extractor.extract(message);
  if (values.length === 0) return;
  const existing = (unwrapHighConfidenceValue(group[extractor.field]) as string[] | null) ?? [];
  const merged = Array.from(new Set([...existing, ...values]));
  const label = values.join('、');
  group[extractor.field] = ruleValue(merged, { evidence: extractor.evidence(label) });
  reasons.push(toReason(label));
}

export function extractHighConfidenceFacts(
  userMessages: string[],
  brandData: BrandItem[],
): HighConfidenceFacts | null {
  const normalizedMessages = userMessages
    .map((message) => stripQuotedBlocks(message.trim()))
    .filter(Boolean);
  if (normalizedMessages.length === 0) return null;

  const facts = cloneFallbackExtraction();
  const reasons: string[] = [];

  // 品牌收口（§9.2）：本函数不再内联直写 preferences.brands——品牌真相唯一存储是
  // brand_state（写入只经 turn-finalizer 的 reducer），preferences.brands 退化为只读投影。
  // 品牌线索仍产出到 reasoning 供排障与提取 prompt 参考。
  const aliasHints = detectBrandAliasHints(normalizedMessages, brandData);
  if (aliasHints.length > 0) {
    reasons.push(
      ...aliasHints.map(
        (hint) =>
          `品牌别名识别：用户原话"${hint.sourceText}"命中"${hint.matchedAlias}" => "${hint.brandName}"`,
      ),
    );
  }

  for (const message of normalizedMessages) {
    // 注册表驱动：统一应用所有"无字段间联动"的标量/数组提取器（见 FIELD_EXTRACTORS）。
    for (const extractor of FIELD_EXTRACTORS) {
      applyFieldExtractor(extractor, message, facts, reasons);
    }

    // ── 以下为带字段间联动 / 自定义合并语义的特殊字段，保留在循环内手写 ──

    // gender：提取成功时联动写入 gender_source='candidate'，注册表的单字段模型表达不了。
    const gender = extractGender(message);
    if (gender && !facts.interview_info.gender) {
      facts.interview_info.gender = ruleValue(gender, {
        evidence: `性别识别：${gender}`,
      });
      facts.interview_info.gender_source = ruleValue('candidate', {
        evidence: '性别来源：候选人自陈',
      });
      reasons.push(`性别识别：${gender}`);
    }

    // is_student + education：一次 extractStudentInfo 同时产出两个字段（且 is_student 走
    // boolean null 判定，education 在缺失时还有 extractEducation 兜底），强耦合不拆。
    const studentInfo = extractStudentInfo(message);
    if (studentInfo.isStudent !== null && facts.interview_info.is_student === null) {
      facts.interview_info.is_student = ruleValue(studentInfo.isStudent, {
        evidence: `学生身份识别：${studentInfo.isStudent ? '是' : '否'}`,
      });
      reasons.push(`学生身份识别：${studentInfo.isStudent ? '是' : '否'}`);
    }
    if (studentInfo.education && !facts.interview_info.education) {
      facts.interview_info.education = ruleValue(studentInfo.education, {
        evidence: `学历识别：${studentInfo.education}`,
      });
      reasons.push(`学历识别：${studentInfo.education}`);
    } else if (!studentInfo.education) {
      const explicitEducation = extractEducation(message);
      if (explicitEducation && !facts.interview_info.education) {
        facts.interview_info.education = ruleValue(explicitEducation, {
          evidence: `学历识别：${explicitEducation}`,
        });
        reasons.push(`学历识别：${explicitEducation}`);
      }
    }

    const scheduleConstraint = extractScheduleConstraintStructured(message);
    if (scheduleConstraint) {
      const existingConstraint = unwrapHighConfidenceValue(facts.preferences.schedule_constraint);
      const merged: ScheduleConstraintFact = {
        onlyWeekends: scheduleConstraint.onlyWeekends ?? existingConstraint?.onlyWeekends ?? null,
        onlyEvenings: scheduleConstraint.onlyEvenings ?? existingConstraint?.onlyEvenings ?? null,
        onlyMornings: scheduleConstraint.onlyMornings ?? existingConstraint?.onlyMornings ?? null,
        maxDaysPerWeek:
          scheduleConstraint.maxDaysPerWeek ?? existingConstraint?.maxDaysPerWeek ?? null,
      };
      const labelParts: string[] = [];
      if (merged.onlyWeekends) labelParts.push('只周末');
      if (merged.onlyEvenings) labelParts.push('只晚班');
      if (merged.onlyMornings) labelParts.push('只早班');
      if (merged.maxDaysPerWeek !== null) labelParts.push(`每周≤${merged.maxDaysPerWeek}天`);
      facts.preferences.schedule_constraint = ruleValue(merged, {
        evidence: `班次硬约束（结构化）：${labelParts.join('、') || '空'}`,
      });
      reasons.push(`班次硬约束（结构化）：${labelParts.join('、') || '空'}`);
    }

    const availableAfter = extractAvailableAfterDate(message, formatLocalDate(new Date()));
    if (availableAfter) {
      facts.preferences.available_after = ruleValue(availableAfter, {
        evidence: `未来日期硬约束：${availableAfter.date}`,
      });
      reasons.push(`未来日期硬约束：${availableAfter.date}（原话："${availableAfter.raw}"）`);
    }

    const location = extractLocation(message);
    if (location.city) {
      facts.preferences.city = ruleValue(location.city.value, {
        evidence: location.city.evidence,
        confidence: location.city.confidence,
      });
      reasons.push(
        `城市识别：${location.city.value}（证据：${location.city.evidence}，置信：${location.city.confidence}）`,
      );
    }
    if (location.district.length > 0) {
      const mergedDistrict = Array.from(
        new Set([
          ...(unwrapHighConfidenceValue(facts.preferences.district) ?? []),
          ...location.district,
        ]),
      );
      facts.preferences.district = ruleValue(mergedDistrict, {
        evidence: `区域识别：${location.district.join('、')}`,
      });
      reasons.push(`区域识别：${location.district.join('、')}`);
    }
    if (location.location.length > 0) {
      const mergedLocation = Array.from(
        new Set([
          ...(unwrapHighConfidenceValue(facts.preferences.location) ?? []),
          ...location.location,
        ]),
      );
      facts.preferences.location = ruleValue(mergedLocation, {
        evidence: `地点识别：${location.location.join('、')}`,
      });
      reasons.push(`地点识别：${location.location.join('、')}`);
    }
  }

  if (!hasAnyExtractedFact(facts)) return null;

  return {
    ...facts,
    reasoning: reasons.length > 0 ? reasons.join('\n') : '本轮前置高置信识别',
  };
}

/**
 * 品牌别名命中提示（适配层，过渡期）。
 *
 * 匹配主体已迁入 `resolution/brand`（§5.1 单一居所），本函数消费新解析结果、
 * 保持旧接口与输出形态兼容：提及级线索（不区分极性——"不要肯德基"仍产出肯德基的
 * 归一化线索，极性语义由 brand_state reducer 消费 resolveBrands 原始结果处理），
 * 品类兜底行为不回归（已上线的咖啡品类召回）。
 */
export function detectBrandAliasHints(
  userMessages: string[],
  brandData: BrandItem[],
): BrandAliasHint[] {
  if (userMessages.length === 0 || brandData.length === 0) return [];

  const hints: BrandAliasHint[] = [];
  const seen = new Set<string>();
  for (const message of userMessages) {
    for (const resolution of resolveBrands(message, 'user_text', brandData)) {
      if (resolution.ambiguous || !resolution.canonicalName) continue;
      const matchedAlias =
        resolution.matchType === 'category_expansion'
          ? `${resolution.matchedText}(品类)`
          : (resolution.matchedText ?? resolution.canonicalName);
      const dedupeKey = `${resolution.canonicalName}::${message}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      hints.push({ brandName: resolution.canonicalName, matchedAlias, sourceText: message });
    }
  }
  return hints;
}

/** 新旧品牌匹配路径的差异快照（对比期观测事件 brand_resolution_shadow_diff 的载荷）。 */
export interface BrandAliasShadowDiff {
  inputs: string[];
  legacyBrands: string[];
  nextBrands: string[];
  catalogSize: number;
}

/**
 * 带新旧对照的品牌线索检测（§15.2 并行对比期）。
 *
 * 新路径（resolveBrands）是生效路径；旧匹配算法作为对照组在 shadow 运行，
 * 两侧品牌集合不一致时返回 diff（由调用方发射 brand_resolution_shadow_diff 事件），
 * 一致时 diff 为 null（仅计数不落行）。旧路径随 §15.6 指标达标后物理删除。
 */
export function detectBrandAliasHintsWithShadow(
  userMessages: string[],
  brandData: BrandItem[],
): { hints: BrandAliasHint[]; shadowDiff: BrandAliasShadowDiff | null } {
  const hints = detectBrandAliasHints(userMessages, brandData);
  if (userMessages.length === 0 || brandData.length === 0) {
    return { hints, shadowDiff: null };
  }

  const legacyBrands = Array.from(
    new Set(legacyDetectBrandAliasHints(userMessages, brandData).map((hint) => hint.brandName)),
  ).sort();
  const nextBrands = Array.from(new Set(hints.map((hint) => hint.brandName))).sort();
  const identical =
    legacyBrands.length === nextBrands.length &&
    legacyBrands.every((brand, index) => brand === nextBrands[index]);

  return {
    hints,
    shadowDiff: identical
      ? null
      : { inputs: userMessages, legacyBrands, nextBrands, catalogSize: brandData.length },
  };
}

/**
 * 旧品牌匹配算法（对照组，§15.6 前保留）：token 全等 + 长别称整句包含 + 品类兜底。
 * 与迁移前的 detectBrandAliasHints 行为一致（基于同一套已迁移的归一化原语重建）。
 */
function legacyDetectBrandAliasHints(
  userMessages: string[],
  brandData: BrandItem[],
): BrandAliasHint[] {
  const { candidates, categories } = buildBrandCatalogIndex(brandData);
  const hints: BrandAliasHint[] = [];
  const seen = new Set<string>();

  const pushHint = (brandName: string, matchedAlias: string, sourceText: string): void => {
    const dedupeKey = `${brandName}::${sourceText}`;
    if (seen.has(dedupeKey)) return;
    hints.push({ brandName, matchedAlias, sourceText });
    seen.add(dedupeKey);
  };

  for (const message of userMessages) {
    const tokens = buildExactMatchTokens(message);
    if (tokens.length === 0) continue;

    const normalizedMessage = normalizeForBrandMatch(message);

    let matchedSpecificBrand = false;
    for (const candidate of candidates) {
      const matched =
        tokens.some((token) => token === candidate.normalized) ||
        (candidate.containEligible && normalizedMessage.includes(candidate.normalized));
      if (!matched) continue;

      matchedSpecificBrand = true;
      pushHint(candidate.brandName, candidate.alias, message);
    }

    if (!matchedSpecificBrand) {
      for (const category of categories) {
        if (!category.keywords.some((keyword) => normalizedMessage.includes(keyword))) continue;
        for (const brandName of category.brands) {
          pushHint(brandName, `${category.label}(品类)`, message);
        }
      }
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
 * "补充字段→不可变合并"的合并器：浅拷贝入参后按来源标签补写字段。
 */
export function mergeSupplementalGenderFact(
  existing: HighConfidenceFacts | null,
  gender: '男' | '女',
  sourceLabel: string,
): HighConfidenceFacts {
  const base: HighConfidenceFacts = existing
    ? {
        ...existing,
        interview_info: { ...existing.interview_info },
        preferences: { ...existing.preferences },
      }
    : cloneFallbackExtraction();

  base.interview_info.gender = highConfidenceValue(gender, {
    confidence: 'low',
    source: 'system',
    evidence: `${sourceLabel}补充性别：${gender}`,
  });
  base.interview_info.gender_source = highConfidenceValue('system', {
    confidence: 'low',
    source: 'system',
    evidence: `${sourceLabel}补充性别来源：系统标签`,
  });
  const suffix = `${sourceLabel}补充性别：${gender}`;
  base.reasoning = [base.reasoning?.trim(), suffix].filter(Boolean).join('；');

  return base;
}

export function unwrapHighConfidenceValue<T>(
  value: HighConfidenceValue<T> | T | null | undefined,
): T | null {
  if (value === null || value === undefined) return null;
  return isHighConfidenceValue(value) ? (value.value as T) : value;
}

export function filterHighConfidenceFacts(
  facts: HighConfidenceFacts | null | undefined,
): HighConfidenceFacts | null {
  if (!facts) return null;

  const filtered: HighConfidenceFacts = {
    interview_info: {
      name: highOnly(facts.interview_info.name),
      phone: highOnly(facts.interview_info.phone),
      gender: highOnly(facts.interview_info.gender),
      gender_source: highOnly(facts.interview_info.gender_source),
      age: highOnly(facts.interview_info.age),
      applied_store: highOnly(facts.interview_info.applied_store),
      applied_position: highOnly(facts.interview_info.applied_position),
      interview_time: highOnly(facts.interview_info.interview_time),
      is_student: highOnly(facts.interview_info.is_student),
      education: highOnly(facts.interview_info.education),
      has_health_certificate: highOnly(facts.interview_info.has_health_certificate),
      experience: highOnly(facts.interview_info.experience),
      upload_resume: highOnly(facts.interview_info.upload_resume),
      height: highOnly(facts.interview_info.height),
      weight: highOnly(facts.interview_info.weight),
      household_register_province: highOnly(facts.interview_info.household_register_province),
    },
    preferences: {
      brands: highOnly(facts.preferences.brands),
      brand_ids: highOnly(facts.preferences.brand_ids),
      salary: highOnly(facts.preferences.salary),
      position: highOnly(facts.preferences.position),
      schedule: highOnly(facts.preferences.schedule),
      city: highOnly(facts.preferences.city),
      district: highOnly(facts.preferences.district),
      location: highOnly(facts.preferences.location),
      labor_form: highOnly(facts.preferences.labor_form),
      delayed_intent: highOnly(facts.preferences.delayed_intent),
      short_term: highOnly(facts.preferences.short_term),
      open_position: highOnly(facts.preferences.open_position),
      time_windows: highOnly(facts.preferences.time_windows),
      schedule_constraint: highOnly(facts.preferences.schedule_constraint),
      available_after: highOnly(facts.preferences.available_after),
    },
    reasoning: facts.reasoning,
  };

  return hasAnyHighConfidenceFact(filtered) ? filtered : null;
}

function highOnly<T>(
  value: HighConfidenceValue<T> | null | undefined,
): HighConfidenceValue<T> | null {
  if (!value) return null;
  return value.confidence === 'high' ? value : null;
}

function hasAnyHighConfidenceFact(facts: HighConfidenceFacts): boolean {
  return (
    Object.values(facts.interview_info as HighConfidenceInterviewInfo).some(Boolean) ||
    Object.values(facts.preferences as HighConfidencePreferences).some(Boolean)
  );
}

function unwrapHighConfidenceCity(value: HighConfidencePreferences['city']): CityFact | null {
  if (!value) return null;
  const evidence = CITY_FACT_EVIDENCES.has(value.evidence as CityFactEvidence)
    ? (value.evidence as CityFactEvidence)
    : 'explicit_city';
  return {
    value: value.value,
    confidence: value.confidence === 'low' ? 'low' : 'high',
    evidence,
  };
}

export function unwrapHighConfidenceFacts(
  facts: HighConfidenceFacts | null | undefined,
): EntityExtractionResult | null {
  if (!facts) return null;
  return {
    interview_info: {
      name: unwrapHighConfidenceValue(facts.interview_info.name),
      phone: unwrapHighConfidenceValue(facts.interview_info.phone),
      gender: unwrapHighConfidenceValue(facts.interview_info.gender),
      gender_source: unwrapHighConfidenceValue(facts.interview_info.gender_source),
      age: unwrapHighConfidenceValue(facts.interview_info.age),
      applied_store: unwrapHighConfidenceValue(facts.interview_info.applied_store),
      applied_position: unwrapHighConfidenceValue(facts.interview_info.applied_position),
      interview_time: unwrapHighConfidenceValue(facts.interview_info.interview_time),
      is_student: unwrapHighConfidenceValue(facts.interview_info.is_student),
      education: unwrapHighConfidenceValue(facts.interview_info.education),
      has_health_certificate: unwrapHighConfidenceValue(
        facts.interview_info.has_health_certificate,
      ),
      experience: unwrapHighConfidenceValue(facts.interview_info.experience),
      upload_resume: unwrapHighConfidenceValue(facts.interview_info.upload_resume),
      height: unwrapHighConfidenceValue(facts.interview_info.height),
      weight: unwrapHighConfidenceValue(facts.interview_info.weight),
      household_register_province: unwrapHighConfidenceValue(
        facts.interview_info.household_register_province,
      ),
    },
    preferences: {
      brands: unwrapHighConfidenceValue(facts.preferences.brands),
      brand_ids: unwrapHighConfidenceValue(facts.preferences.brand_ids),
      salary: unwrapHighConfidenceValue(facts.preferences.salary),
      position: unwrapHighConfidenceValue(facts.preferences.position),
      schedule: unwrapHighConfidenceValue(facts.preferences.schedule),
      city: unwrapHighConfidenceCity(facts.preferences.city),
      district: unwrapHighConfidenceValue(facts.preferences.district),
      location: unwrapHighConfidenceValue(facts.preferences.location),
      labor_form: unwrapHighConfidenceValue(facts.preferences.labor_form),
      delayed_intent: unwrapHighConfidenceValue(facts.preferences.delayed_intent),
      short_term: unwrapHighConfidenceValue(facts.preferences.short_term),
      open_position: unwrapHighConfidenceValue(facts.preferences.open_position),
      time_windows: unwrapHighConfidenceValue(facts.preferences.time_windows),
      schedule_constraint: unwrapHighConfidenceValue(facts.preferences.schedule_constraint),
      available_after: unwrapHighConfidenceValue(facts.preferences.available_after),
    },
    reasoning: facts.reasoning,
  };
}

/**
 * 全字段 null 的高置信事实空模板。
 *
 * 不再手写镜像清单：直接深拷贝 FALLBACK_EXTRACTION（其 interview_info/preferences 的
 * 字段集由 session-facts.types 的单一字段清单生成，且加载期自检保证与各 schema 一致），
 * 所有字段值均为 null，结构上同时满足 HighConfidenceFacts；reasoning 也随之同步。
 */
function cloneFallbackExtraction(): HighConfidenceFacts {
  return structuredClone(FALLBACK_EXTRACTION) as unknown as HighConfidenceFacts;
}

/**
 * 注册表完备性自检：每个 FIELD_EXTRACTORS 声明的字段路径，必须在三处手工镜像
 * 清单（cloneFallbackExtraction 的 null 初始化、filterHighConfidenceFacts 的 highOnly、
 * unwrapHighConfidenceFacts 的 unwrap）里都存在 key，否则该字段会被静默丢弃。
 *
 * 这里在模块加载时即刻校验，任何注册表/镜像清单失配会立即抛错（被测试或启动捕获），
 * 把"漏一处静默丢字段"从运行期隐患提前到编译/加载期失败。
 */
function assertRegistryFieldsMirrored(): void {
  // 用一个"所有注册表字段都填了 high 占位值"的样本驱动校验：
  // filter/unwrap 在有事实时返回非 null，逐字段检查 key 是否被保留。
  const probe = cloneFallbackExtraction();
  for (const extractor of FIELD_EXTRACTORS) {
    const group = probe[extractor.group] as unknown as Record<
      string,
      HighConfidenceValue<unknown> | null
    >;
    const placeholder = extractor.merge === 'union-array' ? ['__probe__'] : '__probe__';
    group[extractor.field] = ruleValue(placeholder, { evidence: 'registry probe' });
  }

  const filtered = filterHighConfidenceFacts(probe);
  const unwrapped = unwrapHighConfidenceFacts(probe);
  const missing: string[] = [];

  const keysOf = (record: object): Record<string, unknown> =>
    record as unknown as Record<string, unknown>;

  for (const extractor of FIELD_EXTRACTORS) {
    const path = `${extractor.group}.${extractor.field}`;
    const inClone = extractor.field in keysOf(probe[extractor.group]);
    const inFilter = !!filtered && extractor.field in keysOf(filtered[extractor.group]);
    const inUnwrap = !!unwrapped && extractor.field in keysOf(unwrapped[extractor.group]);
    if (!inClone || !inFilter || !inUnwrap) missing.push(path);
  }

  if (missing.length > 0) {
    throw new Error(
      `[high-confidence-facts] 注册表字段未在镜像清单中完整登记，会被静默丢弃：${missing.join(', ')}`,
    );
  }
}

assertRegistryFieldsMirrored();

function ruleMeta(params: {
  evidence: string;
  confidence?: HighConfidenceValue<unknown>['confidence'];
}): Omit<HighConfidenceValue<unknown>, 'value'> {
  return {
    confidence: params.confidence ?? 'high',
    source: 'rule',
    evidence: params.evidence,
  };
}

function highConfidenceValue<T>(
  value: T,
  meta: Omit<HighConfidenceValue<T>, 'value'>,
): HighConfidenceValue<T> {
  return { value, ...meta };
}

function ruleValue<T>(
  value: T,
  params: { evidence: string; confidence?: HighConfidenceValue<T>['confidence'] },
): HighConfidenceValue<T> {
  return highConfidenceValue(value, ruleMeta(params) as Omit<HighConfidenceValue<T>, 'value'>);
}

export function isHighConfidenceValue(value: unknown): value is HighConfidenceValue<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'confidence' in value &&
    'source' in value &&
    'evidence' in value
  );
}

function hasAnyExtractedFact(facts: HighConfidenceFacts): boolean {
  return hasAnyValue(facts.interview_info) || hasAnyValue(facts.preferences);
}

function hasAnyValue(record: object): boolean {
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

/**
 * 身高提取：候选人主动给出或表单回填「身高：170 / 身高 175cm」→ 数字字符串。
 *
 * 与 STRUCTURED_NAME_REGEX 同构的键值对模式：值取紧跟标签的 2-3 位数字，
 * 落在合理人类身高区间（100-250cm）才接受，避免「身高要求165以上」这类岗位
 * 要求被误捕——要求/限制语境（要求/限/需/不低于/以上/以下）一律不提取。
 */
function extractHeight(message: string): string | null {
  if (/身高\s*(?:要求|需要|限|须|不低于|不高于|至少|最低|最高)/.test(message)) return null;
  const match = message.match(
    /身高\s*[：:\s]?\s*(\d{2,3})(?=\s*(?:cm|厘米|公分)?(?![0-9-~至到以])|$)/u,
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (value < 100 || value > 250) return null;
  return match[1];
}

/**
 * 体重提取：候选人主动给出或表单回填「体重：60 / 体重 60kg」→ 数字字符串。
 *
 * 同身高，落在合理区间（30-200kg）才接受；要求/限制语境一律不提取。
 */
function extractWeight(message: string): string | null {
  if (/体重\s*(?:要求|需要|限|须|不低于|不高于|至少|最低|最高)/.test(message)) return null;
  const match = message.match(
    /体重\s*[：:\s]?\s*(\d{2,3})(?=\s*(?:kg|公斤|千克|斤)?(?![0-9-~至到以])|$)/u,
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (value < 30 || value > 200) return null;
  return match[1];
}

/**
 * 户籍省份提取（敏感字段）：仅接受表单回填的键值对形态「户籍：安徽 / 籍贯：四川省」。
 *
 * 不做自由文本推断（"我是安徽人"不提取），值延伸到行尾，经省份白名单校验后返回。
 */
const HOUSEHOLD_REGISTER_REGEX =
  /(?:^|[\n\r])\s*(?:户籍|籍贯)(?:所在地|地)?\s*[：:\s]\s*([^\n\r。，,！!？?；;]+?)(?=[\n\r]|$)/u;

const PROVINCE_NAMES = [
  '北京',
  '天津',
  '上海',
  '重庆',
  '河北',
  '山西',
  '辽宁',
  '吉林',
  '黑龙江',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '海南',
  '四川',
  '贵州',
  '云南',
  '陕西',
  '甘肃',
  '青海',
  '台湾',
  '内蒙古',
  '广西',
  '西藏',
  '宁夏',
  '新疆',
  '香港',
  '澳门',
] as const;

function extractHouseholdRegisterProvince(message: string): string | null {
  const match = HOUSEHOLD_REGISTER_REGEX.exec(message);
  if (!match?.[1]) return null;
  const candidate = match[1].trim();
  if (!candidate) return null;
  // 取最长匹配省份名（"黑龙江"优先于子串），校验后返回原文片段（保留"省"等后缀语义）。
  const matchedProvince = [...PROVINCE_NAMES]
    .sort((a, b) => b.length - a.length)
    .find((province) => candidate.includes(province));
  return matchedProvince ? candidate : null;
}

function extractAge(message: string): string | null {
  // 结构化表单优先：「年龄：22 / 年龄 22 / 年龄22」可信度最高，
  // 即使同一消息含要求文本也应提取。避免把「年龄25-50岁」范围误当候选人年龄。
  const structuredAge = message.match(
    /(?:^|[\n\r])\s*年龄\s*[：:\s]?\s*(\d{2})(?!\s*[-~至到])(?=\D|$)/u,
  );
  if (structuredAge) return structuredAge[1];

  // 排除岗位要求/范围描述（仅对非结构化提取生效），但保留同句中的候选人自述：
  // 「岗位要求25-50岁，我24岁」应提取 24；「要求20-35岁」仍应返回 null。
  const candidateText = message
    .replace(
      /(?:岗位)?(?:年龄)?(?:要求|需要|限|须)[^，。！？；;\n\r]*?\d{2}\s*(?:[-~至到]\s*\d{2})?\s*(?:周?岁|岁以上|岁以下|以上|以下)?/g,
      '',
    )
    .replace(/\d{2}\s*[-~至到]\s*\d{2}\s*(?:周?岁|岁)?/g, '');

  const directAge = candidateText.match(/(\d{2})岁/);
  if (directAge) return directAge[1];

  const currentAge = candidateText.match(/今年(\d{2})/);
  if (currentAge) return currentAge[1];

  return null;
}

function extractGender(message: string): string | null {
  // 裸 /男的/ /女的/ 误捕面太大（"我朋友是男的""你们要男的女的吗"）。收紧为：
  // 1) 明确自陈/表单前缀照旧；
  // 2) "男的/女的"仅在【独立短语段】（标点/句首分隔，如"我25岁，男的，本科"）按自述接受；
  // 3) 询问/岗位要求/第三人称/并提语境一律排除。
  if (/男的女的|女的男的/.test(message)) return null;
  if (/(?:要|招|找|限|收)\s*(?:男|女)的/.test(message)) return null;
  if (
    /(?:朋友|对象|老公|老婆|男朋友|女朋友|孩子|儿子|女儿|同学|室友|他|她)[^，,。;；]{0,4}[男女]的/.test(
      message,
    )
  ) {
    return null;
  }

  if (/(我是|本人|性别)[：: ]?(男生|男)/.test(message)) return '男';
  if (/(我是|本人|性别)[：: ]?(女生|女)/.test(message)) return '女';

  const standalone = /(?:^|[，,。;；！!\s])(?:就?是)?([男女])的(?=[，,。;；！!~～\s]|$)/.exec(
    message,
  );
  if (standalone) return standalone[1];
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
  // 反向触发：候选人明确说自己已离开校园 → is_student=false。
  // 不能只搜“社会人士”关键词：“社会人士岗位会影响读书吗”“不是有招
  // 社会人士岗吗”都在讨论岗位要求，不是候选人改口自报身份。
  // badcase v9mxbgiv：候选人回"社会人士，目前待岗状态"，规则只覆盖"不是学生|已毕业"导致漏判，
  // Agent 反复追问"学生还是社会人士"。需要与 LLM 抽取（session-extraction.prompt.ts）的
  // 反向触发词保持一致。
  if (
    /(?:^|[\s，,。！!；;])(?:我(?:现在)?(?:是|算)?|身份(?:[（(]学生\s*[/／]\s*社会人士[）)])?\s*[：:]\s*)?社会人士(?:$|[\s，,。！!；;])/.test(
      message,
    ) ||
    /不是学生|已经?毕业|毕业了|上班族|已经工作|工作过|在职|待岗|失业|退休|全职妈妈|在家带娃/.test(
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
  // “怎么办/能不能办”只是在询问流程或可行性，不能据此推断候选人承诺或拒绝办理。
  if (
    /(?:怎么办|怎么(?:去)?办|如何办|能不能办|可不可以办|可以不可以办|要不要办).{0,8}健康证/.test(
      message,
    )
  ) {
    return null;
  }
  if (
    /(?:拒绝|没法|无法|(?:不|没|未)(?:太|怎么|很)?(?:接受|愿意|想|打算|准备|考虑|会|能|可以)).{0,24}(?:去|再)?(?:体检.{0,10})?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|不(?:去|再)?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|健康证.{0,24}(?:拒绝|没法|无法|(?:不|没|未)(?:太|怎么|很)?(?:接受|愿意|想|打算|准备|考虑|会|能|可以)).{0,12}(?:去|再)?办(?:理)?/.test(
      message,
    )
  ) {
    return '无且不接受办理健康证';
  }
  // 生产口语常把意愿说成“后期去体检，然后办一个健康证”，而不使用标准的
  // “可以办健康证”。这类带明确将来/意愿动词的表述与标准枚举语义一致。
  if (
    /(?<![不没未无非])(?:接受|愿意|可以|可|能|会|打算|准备|考虑|确定|后期|后面|之后|到时|到时候|入职前|上岗前).{0,24}(?:去|再)?(?:体检.{0,10})?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|去体检.{0,12}办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|健康证.{0,30}(?<![不没未无非])(?:接受|愿意|可以|能|会|打算|准备|考虑|确定).{0,12}(?:去|再)?办(?:理)?/.test(
      message,
    )
  ) {
    return '无但接受办理健康证';
  }
  if (
    /健康证\s*[：:]\s*(?:无|没有)(?:$|[\s，,。；;])/u.test(message) ||
    /没有(?:食品|餐饮|零售)?(?:类)?健康证|没健康证|无健康证/.test(message)
  )
    return '无';
  if (
    /健康证.{0,6}(?:不是|非)本地|(?:外地|异地).{0,3}健康证|健康证.{0,4}(?:外地|异地)/.test(message)
  ) {
    return '非本地健康证';
  }
  if (/有健康证|本地.{0,4}健康证|健康证.{0,4}本地|(?:食品|餐饮|零售)(?:类)?健康证/.test(message)) {
    return '有';
  }
  return null;
}

function extractExperience(message: string): string | null {
  const labeled = message.match(
    /(?:过往公司\+岗位\+年限|工作经历|工作经验|近一段工作经历)\s*[：:]\s*([^\n\r]+)/u,
  )?.[1];
  if (labeled) return sanitizeExperienceText(labeled);

  const durationPattern =
    '(?:\\d+|[一二两三四五六七八九十半]+)\\s*(?:个?多?月|个月|月多|月|年多?|年)';
  const rolePattern =
    '(?:服务员|店员|收银员?|后厨|前厅|补货|分拣|打包|营业员|导购|咖啡师|饭店|餐饮)';

  const explicit = new RegExp(
    `((?:肯德基|KFC|[一-龥A-Za-z0-9]{2,20}(?:店|饭店|餐厅|自助|烤肉|咖啡|超市)?)[^，。,.!！?？\\n]{0,12}(?:${rolePattern})?[^，。,.!！?？\\n]{0,6}(?:做了|做|干了|干|工作了)?\\s*${durationPattern})`,
    'iu',
  ).exec(message)?.[1];
  if (explicit) return sanitizeExperienceText(explicit);

  const generic = new RegExp(
    `((?:做|干)(?:饭店|餐饮|服务员|店员)[^，。,.!！?？\\n]{0,8}${durationPattern})`,
    'iu',
  ).exec(message)?.[1];
  return generic ? sanitizeExperienceText(generic) : null;
}

function sanitizeExperienceText(value: string): string | null {
  const text = value
    .trim()
    .replace(/[。；;]+$/u, '')
    .replace(/\s+/g, '');
  if (!text) return null;
  if (!/(?:\d+|[一二两三四五六七八九十半]).*(?:月|年)/.test(text)) return null;
  return text.length > 80 ? text.slice(0, 80) : text;
}

function extractUploadResume(message: string): string | null {
  // "简历附件："分支只认 URL：候选人回填模板时常把别的内容连在这一行后面
  // （如"简历附件：过往公司+岗位+年限：…"），这类文字一旦入档会被 booking
  // 当作云存储 key 提交，海绵侧简历直接打不开（工单 438358 事故）。
  const labeled = message.match(/简历附件\s*[：:]\s*(\S+)/u)?.[1];
  if (labeled) {
    const sanitized = sanitizeResumeUrl(labeled);
    if (sanitized && /^https?:\/\//i.test(sanitized)) return sanitized;
  }

  if (!/\[文件消息\]/.test(message)) return null;

  const fileName = message.match(/文件名\s*[：:]\s*([^；;\n\r]+)/u)?.[1] ?? '';
  if (!isResumeFileName(fileName)) return null;

  const fileUrl = message.match(/文件地址\s*[：:]\s*([^；;\n\r]+)/u)?.[1];
  return fileUrl ? sanitizeResumeUrl(fileUrl) : null;
}

function isResumeFileName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase();
  return /简历|履历|resume/.test(normalized) || /(?:^|[^a-z0-9])cv(?:[^a-z0-9]|$)/.test(normalized);
}

function sanitizeResumeUrl(value: string): string | null {
  const trimmed = value.trim().replace(/[，。；;、)）\]]+$/u, '');
  return trimmed.length > 0 ? trimmed : null;
}

function extractLaborForm(message: string): string | null {
  const intent = decideLaborFormIntent(message);
  return intent.kind === 'set' ? intent.value : null;
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

  // "找周六的兼职"式求职意图：没有"只"字也按周末可用性约束沉淀
  if (result.onlyWeekends === null && WEEKEND_SEEK_PATTERN.test(message)) {
    result.onlyWeekends = true;
  }

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

/** "X附近"里 X 是泛指而非地名的停用词：这些词入库只会污染 pref.location。 */
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

function extractNearbyLocations(message: string, districts: string[]): string[] {
  const nearbyMatch = message.match(
    /(?:我在|人在|在|住在)?([\u4e00-\u9fa5A-Za-z0-9]{2,20})(?:附近|旁边)/,
  );
  if (!nearbyMatch?.[1]) return [];

  const location = nearbyMatch[1].trim();
  if (!location) return [];
  // 泛指词（"公司附近/家附近"）不是地名直接丢弃；带前缀的（"我公司附近"）按后缀命中也丢
  if (NEARBY_LOCATION_STOPWORDS.has(location)) return [];
  if ([...NEARBY_LOCATION_STOPWORDS].some((word) => location.endsWith(word))) return [];
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
