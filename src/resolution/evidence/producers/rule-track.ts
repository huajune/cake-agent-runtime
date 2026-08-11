import type { BrandItem } from '@/sponge/sponge.types';
import { formatLocalDate } from '@infra/utils/date.util';
import type {
  CityFact,
  CityFactEvidence,
  EntityExtractionResult,
  HighConfidenceInterviewInfo,
  HighConfidencePreferences,
  HighConfidenceFacts,
  HighConfidenceValue,
  ScheduleConstraintFact,
} from '@memory/types/session-facts.types';
import { scanGeoSignalsFromText } from '@resolution/geo';
import {
  extractLocationShareLabels,
  stripQuotedBlocks as stripQuotedBlocksMarkup,
} from '@infra/utils/message-markup.util';
import {
  extractStructuredName as extractCandidateStructuredName,
  normalizeGenderValue as normalizeCandidateGenderValue,
  parseAge as parseCandidateAge,
  parseEducation as parseCandidateEducation,
  parseGender as parseCandidateGender,
  parseHealthCertificate as parseCandidateHealthCertificate,
  parseHeight as parseCandidateHeight,
  parseHouseholdProvince as parseCandidateHouseholdProvince,
  parsePhone as parseCandidatePhone,
  parseWeight as parseCandidateWeight,
  stripTimeContextSuffix,
} from '@resolution/candidate';
import { matchIdentityStatement } from '@resolution/candidate/student-identity';
import { decideLaborFormIntent } from '@resolution/labor-form';
import { fieldValues, type FinalizedVisualFactSheet } from '@resolution/visual';
import { resolveExtractionScope } from '@resolution/evidence/admission';
import {
  produceBrandAliasHints,
  type BrandAliasHint,
} from '@resolution/evidence/producers/brand-intents';

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

export type { BrandAliasHint } from '@resolution/evidence/producers/brand-intents';

interface LocationSignals {
  city: CityFact | null;
  district: string[];
  location: string[];
}

/**
 * 剥离引用消息块，只保留候选人自己写的内容。
 *
 * 被引用内容通常是招募经理发的岗位描述，其中的年龄/班次/薪资等数值属于岗位要求，
 * 不是候选人自陈——必须在规则提取前剥离，否则所有 extract* 函数都会误提取引用块内的
 * 实体（品牌解析同理：引用块里的品牌是经理的话）。
 *
 * 标记形态（`[引用 XXX：…]` / 行首 `引用 XXX：`）见 @infra/utils/message-markup；
 * 此处保留具名转出，因为 6 个提取路径消费的是"提取前先剥引用"这条语义。
 */
export const stripQuotedBlocks = stripQuotedBlocksMarkup;

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

// 提取授权域（kind → identity/phone/preferences/geo）已收拢至
// @resolution/visual 的 visual-fact.policy：规则只由 sheet kind 决定，与消费点无关，
// 且在域内有 Record<VisualFactKind,…> 的加档编译期约束。

export interface ExtractHighConfidenceOptions {
  /** 剥时间后缀内容 → sheet 的映射（visual-fact-structuring 消费侧读路径）。 */
  visualSheetsByContent?: ReadonlyMap<string, FinalizedVisualFactSheet>;
}

export function extractHighConfidenceFacts(
  userMessages: string[],
  brandData: BrandItem[],
  options?: ExtractHighConfidenceOptions,
): HighConfidenceFacts | null {
  const normalizedMessages = userMessages
    .map((message) => stripQuotedBlocks(message.trim()))
    .filter(Boolean);
  if (normalizedMessages.length === 0) return null;

  const facts = cloneFallbackExtraction();
  const reasons: string[] = [];
  // 查表键必须剥时间后缀（评审阻断项，2026-08-05）：map 键是 DB 原始内容（无后缀），
  // 而生产窗口消息带 injectTimeContext 注入的 `\n[消息发送时间：…]` 后缀——不剥则
  // 查表永远 miss，sheet 授权域静默失效、全部回落文本兜底（测试曾因 fixture 无后缀漏过）。
  const sheetFor = (message: string): FinalizedVisualFactSheet | undefined =>
    options?.visualSheetsByContent?.get(stripTimeContextSuffix(message).trim());

  // 品牌收口（§9.2）：本函数不内联直写 preferences.brands——品牌真相唯一存储是
  // brand_state（写入只经 reducer），preferences.brands 已退役（§19.6）、读边界恒 null。
  // 品牌线索仍产出到 reasoning 供排障与提取 prompt 参考。
  // R2 发布方剔除：带 job_posting sheet 的消息，品牌线索只吃 key=brand 字段值
  // （发布方公司名在 key=publisher，不进品牌语料）；其余消息照旧全文。
  const hintCorpus = normalizedMessages.map((message) => {
    const sheet = sheetFor(message);
    if (sheet && !sheet.degraded && sheet.kind === 'job_posting') {
      return fieldValues(sheet, 'brand').join('；');
    }
    return message;
  });
  const aliasHints = detectBrandAliasHints(hintCorpus.filter(Boolean), brandData);
  if (aliasHints.length > 0) {
    reasons.push(
      ...aliasHints.map(
        (hint) =>
          `品牌别名识别：用户原话"${hint.sourceText}"命中"${hint.matchedAlias}" => "${hint.brandName}"`,
      ),
    );
  }

  // 自陈收窄（badcase 2026-08-04 vkikct39）：候选人转发的第三方岗位截图，其 vision
  // 描述被回写进用户消息内容，描述里**发布方**的手机号与"18-40岁"岗位年龄区间会被
  // 身份字段提取器当成候选人自陈。与 stripQuotedBlocks 同一理由：第三方内容不是自陈。
  //
  // 收窄范围严格限定在 interview_info（"候选人是谁"）+ gender：
  // - preferences（薪资/班次/工种/用工形式）与 city/district/location 刻意不收窄——
  //   候选人发地图截图指位置是被期待的能力（badcase oaz6inzf 的诉求正是"图上已经
  //   看到是北京了还问城市"），一刀切会把它打掉；
  // - 品牌线索同理，图片品牌解析是 §10.2 的显式通道。
  for (const message of normalizedMessages) {
    const scope = resolveExtractionScope(message, sheetFor(message));
    const isSelfReported = scope.identity;

    // 注册表驱动：统一应用所有"无字段间联动"的标量/数组提取器（见 FIELD_EXTRACTORS）。
    for (const extractor of FIELD_EXTRACTORS) {
      if (extractor.group === 'interview_info') {
        if (!scope.identity) continue;
        if (extractor.field === 'phone' && !scope.phone) continue;
      }
      if (extractor.group === 'preferences' && !scope.preferences) continue;
      applyFieldExtractor(extractor, message, facts, reasons);
    }

    // ── 以下为带字段间联动 / 自定义合并语义的特殊字段，保留在循环内手写 ──

    // gender：提取成功时联动写入 gender_source='candidate'，注册表的单字段模型表达不了。
    // 同属身份字段：岗位截图里的"仅限男"不是候选人性别。
    const gender = isSelfReported ? extractGender(message) : null;
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
    // 同属身份字段：岗位截图里的"限在校大学生/大专以上"是岗位要求，不是候选人学历。
    const studentInfo = isSelfReported
      ? extractStudentInfo(message)
      : { isStudent: null, education: null };
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
    } else if (!studentInfo.education && scope.identity) {
      // 兜底路径同受身份域门控（评审阻断项）：岗位截图"学历要求：大专以上"不得入档
      const explicitEducation = extractEducation(message);
      if (explicitEducation && !facts.interview_info.education) {
        facts.interview_info.education = ruleValue(explicitEducation, {
          evidence: `学历识别：${explicitEducation}`,
        });
        reasons.push(`学历识别：${explicitEducation}`);
      }
    }

    const scheduleConstraint = scope.preferences
      ? extractScheduleConstraintStructured(message)
      : null;
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

    const availableAfter = scope.preferences
      ? extractAvailableAfterDate(message, formatLocalDate(new Date()))
      : null;
    if (availableAfter) {
      facts.preferences.available_after = ruleValue(availableAfter, {
        evidence: `未来日期硬约束：${availableAfter.date}`,
      });
      reasons.push(`未来日期硬约束：${availableAfter.date}（原话："${availableAfter.raw}"）`);
    }

    const location = scope.geo
      ? extractLocation(message)
      : { city: null, district: [], location: [] };
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
 * 品牌别名命中提示（常设：提取提示词 [规则模式匹配线索] 的品牌线索唯一产出层）。
 *
 * 匹配主体已迁入 `resolution/brand`（§5.1 单一居所），本函数消费新解析结果、
 * 保持旧接口与输出形态兼容：提及级线索（不区分极性——"不要肯德基"仍产出肯德基的
 * 归一化线索，极性语义由 brand_state reducer 消费 resolveBrands 原始结果处理），
 * 品类兜底行为不回归（已上线的咖啡品类召回）。
 *
 * 引用块在**本函数内**剥离，不依赖调用方：引用块里的品牌是招募经理/Agent 的话，
 * 不是候选人自陈。2026-07-21 生产实例 6a5f21ef——候选人引用 Agent 的
 * 「零售群是超市、便利店、门店导购这类」，"便利店"命中品牌"7-11便利店"并进入
 * 提取提示词，形成 Agent 说品牌 → 候选人引用 → 品牌被当作其兴趣的自污染回路。
 * 根因是调用方（session.service extractFacts）传了原始消息，而剥离契约只写在
 * stripQuotedBlocks 的注释里、无结构约束。收进入口后调用方无法再漏（幂等，
 * extractHighConfidenceFacts 侧已剥过一次也无副作用）。
 */
export function detectBrandAliasHints(
  userMessages: string[],
  brandData: BrandItem[],
): BrandAliasHint[] {
  return produceBrandAliasHints(userMessages, brandData);
}

/**
 * 把外部数据源（如客户详情接口）补充来的性别值归一化为 '男' | '女'。
 *
 * 接受数字/字符串/英文/中文短语等常见输入形态，并保留若干边界特性：
 * - /(^|[^女])男/ 要求 '男' 前是起始或非 '女'，避免 "不男"/"非男" 被误判
 * - 同时出现 "男" 和 "女" 时视为非单值表达（如 "男女不限" / "男女皆可"），返回 null
 */
export function normalizeGenderValue(value: unknown): '男' | '女' | null {
  return normalizeCandidateGenderValue(value);
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
  return {
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
      experience: null,
      upload_resume: null,
      height: null,
      weight: null,
      household_register_province: null,
    },
    preferences: {
      brands: null,
      brand_ids: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning: '规则轨空值模板',
  };
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
export function extractStructuredName(message: string): string | null {
  return extractCandidateStructuredName(message);
}

function extractPhone(message: string): string | null {
  return parseCandidatePhone(message);
}

/**
 * 身高提取：候选人主动给出或表单回填「身高：170 / 身高 175cm」→ 数字字符串。
 *
 * 与 STRUCTURED_NAME_REGEX 同构的键值对模式：值取紧跟标签的 2-3 位数字，
 * 落在合理人类身高区间（100-250cm）才接受，避免「身高要求165以上」这类岗位
 * 要求被误捕——要求/限制语境（要求/限/需/不低于/以上/以下）一律不提取。
 */
function extractHeight(message: string): string | null {
  const value = parseCandidateHeight(message);
  return value === null ? null : String(value);
}

/**
 * 体重提取：候选人主动给出或表单回填「体重：60 / 体重 60kg」→ 数字字符串。
 *
 * 同身高，落在合理区间（30-200kg）才接受；要求/限制语境一律不提取。
 */
function extractWeight(message: string): string | null {
  const value = parseCandidateWeight(message);
  return value === null ? null : String(value);
}

/**
 * 户籍省份提取（敏感字段）：仅接受表单回填的键值对形态「户籍：安徽 / 籍贯：四川省」。
 *
 * 不做自由文本推断（"我是安徽人"不提取），值延伸到行尾，经省份白名单校验后返回。
 */
function extractHouseholdRegisterProvince(message: string): string | null {
  return parseCandidateHouseholdProvince(message);
}

function extractAge(message: string): string | null {
  const value = parseCandidateAge(message);
  return value === null ? null : String(value);
}

function extractGender(message: string): string | null {
  return parseCandidateGender(message);
}

function extractStudentInfo(message: string): {
  isStudent: boolean | null;
  education: string | null;
} {
  if (/本科在读/.test(message)) {
    return { isStudent: true, education: '本科' };
  }
  if (/硕士在读|研究生在读|研一|研二|研三/.test(message)) {
    return { isStudent: true, education: '硕士' };
  }
  if (/博士在读|博一|博二|博三/.test(message)) {
    return { isStudent: true, education: '博士' };
  }
  if (/考上研究生|研究生.*录取|录取.*研究生|准研究生|待入学|准备读研|读研|上研/.test(message)) {
    return { isStudent: true, education: '硕士' };
  }
  const identity = matchIdentityStatement(message);
  return {
    isStudent: identity === null ? null : identity === '学生',
    education: parseCandidateEducation(message),
  };
}

function extractEducation(message: string): string | null {
  return parseCandidateEducation(message);
}

function extractHealthCertificate(message: string): string | null {
  return parseCandidateHealthCertificate(message);
}

function extractExperience(message: string): string | null {
  const labeled = message.match(
    /(?:过往公司\+岗位\+年限|工作经历|工作经验|近一段工作经历)\s*[：:]\s*([^\n\r]+)/u,
  )?.[1];
  if (labeled) return sanitizeExperienceText(labeled);

  // 时长里的空白只允许行内空格/制表符：`\s` 会吃掉 `\n`，让匹配跨行拼接。
  // badcase 2026-08-06 chat 6a1e42c5（近 7 天 9 个会话、34 个 turn 同形态）：
  // 候选人按收资模板换行回填"电话13872896163\n年龄22"，正文由"电话1387289616"起头、
  // `\d+` 吃掉"3"、`\s*` 跨过换行、`年` 取自下一行"年龄"，得到
  // interview.experience="电话13872896163年"（source=rule / confidence=high），
  // 并已随 precheck 的 templateText 渲染成"过往公司+岗位+年限：电话13872896163年"。
  const inlineSpace = '[ \\t]*';
  const durationPattern = `(?:\\d+|[一二两三四五六七八九十半]+)${inlineSpace}(?:个?多?月|个月|月多|月|年多?|年)`;
  const rolePattern =
    '(?:服务员|店员|收银员?|后厨|前厅|补货|分拣|打包|营业员|导购|咖啡师|饭店|餐饮)';

  const explicit = new RegExp(
    `((?:肯德基|KFC|[一-龥A-Za-z0-9]{2,20}(?:店|饭店|餐厅|自助|烤肉|咖啡|超市)?)[^，。,.!！?？\\n]{0,12}(?:${rolePattern})?[^，。,.!！?？\\n]{0,6}(?:做了|做|干了|干|工作了)?${inlineSpace}${durationPattern})`,
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
  // 第二道门：正则跨行是已修的首因，但"电话行被当经历"这一类结果无论从哪条路径产生
  // 都不该入档——它会随 booking 的"过往公司+岗位+年限"字段提交到工单。
  // 只用手机号形态判定：观测到的 4 种脏值形态全部含 11 位手机号
  // （6a1e42c5「电话13872896163年」/ 6a6837b6「手机号：17696566584年」/
  //   6a6c5634「联系方式：19663930499年」/ 6a6ac29b「庞子瑞18036615809女8月」），
  // 而真实经历不会内嵌手机号。刻意不按"电话/手机"标签词拒——"华为手机店做了3年"
  // "电话客服干了2年"都是合法经历，标签门会误杀且无实证收益。
  if (parseCandidatePhone(text)) return null;
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
 * 三轮白名单扫描的编排（city → district → location → 未覆盖段正则兜底，
 * 覆盖逐轮继承）已按方案 §8.4 收口为 @resolution/geo 的 scanGeoSignalsFromText，
 * 行为由 Phase 0 golden cases 锁定。本函数只保留消息形态相关的抽取
 * （位置分享 / "XX附近"）与 CityFact 置信度包装——记忆如何消费扫描结果归
 * memory，扫描本身归 geo。
 */
function extractLocation(message: string): LocationSignals {
  const positionShareLocations = extractPositionShareLocations(message);

  const geoScan = scanGeoSignalsFromText(message);
  const city: CityFact | null = geoScan.city
    ? { value: geoScan.city.value, confidence: 'high', evidence: geoScan.city.evidence }
    : null;
  const districts = geoScan.districts;

  // location：位置分享 title/address + 白名单命中 + "XX附近/旁边" 兜底
  const nearbyLocations = extractNearbyLocations(message, districts);
  const locations = Array.from(
    new Set([...positionShareLocations, ...geoScan.locations, ...nearbyLocations].filter(Boolean)),
  );

  return { city, district: districts, location: locations };
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

/**
 * “X 附近”中的 X 可能是查岗动作而不是地点。
 *
 * 例如“直接编一家附近门店”“帮我找一家附近的店”会被宽松兜底捕获为
 * “直接编一家 / 帮我找一家”。只拦动作词 + 可选数量/分类词的尾部，保留
 * “人民广场 / 张江高科 / 回龙观”等真实地点及“查桥镇”这类含同形字的地名。
 */
const NON_LOCATION_NEARBY_ACTION_TAIL_PATTERN =
  /(?:编|找|查|搜|看|推荐|介绍|选|挑)(?:一|两|几)?(?:个|家|些|下)?$/u;

/**
 * 只剔除有明确查询语义的前缀，不剥裸单字“查”，以免把“查桥镇”改坏。
 * 返回 null 表示整个候选只是“找我/查一下我”这类动作语。
 */
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

  // “一家/一个/我这边”只能在前面确实剔除了查询动作后再清理；
  // 否则会把“家乐福/一大会址/两路口/个旧”这些真实地名截断。
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
  // 泛指词（"公司附近/家附近"）不是地名直接丢弃；带前缀的（"我公司附近"）按后缀命中也丢
  if (NEARBY_LOCATION_STOPWORDS.has(location)) return [];
  if ([...NEARBY_LOCATION_STOPWORDS].some((word) => location.endsWith(word))) return [];
  if (NON_LOCATION_NEARBY_ACTION_TAIL_PATTERN.test(location)) return [];
  if (districts.some((district) => location.includes(district))) return [];
  return [location];
}

function extractPositionShareLocations(message: string): string[] {
  return extractLocationShareLabels(message);
}
