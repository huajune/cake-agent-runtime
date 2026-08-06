import type { BrandItem } from '@/sponge/sponge.types';
import { resolveBrands } from '@resolution/brand/brand-matcher';
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
import { scanGeoSignalsFromText } from '@resolution/geo';
import { isLikelyRealChineseName, stripTimeContextSuffix } from './name-guard';
import { decideLaborFormIntent } from './labor-form';
import {
  fieldValues,
  isSelfReportedVisualMessage,
  isVisualDescriptionText,
  type FinalizedVisualFactSheet,
} from '@resolution/visual';

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

/** 每条消息的提取授权域（visual-fact-structuring 附录 A 三通道模型的规则轨投影）。 */
interface MessageExtractionScope {
  /** 身份字段（interview_info + gender + is_student/education）。 */
  identity: boolean;
  /** 手机号单列：证件/简历图上的号码按裁决 B3 不得经规则轨落 high（LLM 轨 medium + 确认升级）。 */
  phone: boolean;
  /** 偏好标量（薪资/班次/用工形式/工种等）。 */
  preferences: boolean;
  /** 地理信号（city/district/location）。 */
  geo: boolean;
}

const SCOPE_ALL: MessageExtractionScope = {
  identity: true,
  phone: true,
  preferences: true,
  geo: true,
};
const SCOPE_NONE: MessageExtractionScope = {
  identity: false,
  phone: false,
  preferences: false,
  geo: false,
};

/**
 * 按消息类别 + sheet kind 决定提取授权域：
 * - 手打文本：全量（现状）
 * - 简历/证件（sheet 或文本标记）：身份可提，phone 除外（B3）；偏好/地理照旧
 * - map_location：仅地理——候选人用地图指自己的位置
 * - job_posting/chat_screenshot/其它 sheet：全关（岗位卡薪资≠期望薪资 R1e；门店城市≠候选人城市）
 * - 视觉消息无 sheet（旧数据/降级）：身份关、偏好+地理开（= PR #870 行为，不劣化地图定位）
 */
function resolveExtractionScope(
  message: string,
  sheet: FinalizedVisualFactSheet | null | undefined,
): MessageExtractionScope {
  if (!isVisualDescriptionText(message)) return SCOPE_ALL;
  if (sheet && !sheet.degraded) {
    if (sheet.kind === 'resume' || sheet.kind === 'certificate') {
      return { identity: true, phone: false, preferences: true, geo: true };
    }
    if (sheet.kind === 'map_location') return { ...SCOPE_NONE, geo: true };
    return SCOPE_NONE;
  }
  if (isSelfReportedVisualMessage(message)) {
    return { identity: true, phone: false, preferences: true, geo: true };
  }
  return { ...SCOPE_NONE, preferences: true, geo: true };
}

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
  if (userMessages.length === 0 || brandData.length === 0) return [];

  const hints: BrandAliasHint[] = [];
  const seen = new Set<string>();
  for (const raw of userMessages) {
    const message = stripQuotedBlocks(raw);
    if (!message) continue;
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

const HEALTH_CERTIFICATE_CONSULTATION_TERMS = [
  '哪里',
  '哪儿',
  '何处',
  '什么地方',
  '怎么办',
  '怎么去办',
  '如何办',
  '能不能办',
  '可不可以办',
  '可以不可以办',
  '要不要办',
  '多少钱',
] as const;

/** 按自然标点保留分句边界，避免后半句咨询抹掉前半句的明确办理承诺。 */
function splitHealthCertificateClauses(message: string): string[] {
  return message
    .split(/(?<=[，,。！？?!；;\n])/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

type HealthCertificateFact =
  | '有'
  | '无'
  | '非本地健康证'
  | '无但接受办理健康证'
  | '无且不接受办理健康证';

function isHealthCertificateQuestionForm(clause: string): boolean {
  return /[？?]|(?:吗|么|呢)(?:[啊呀嘛])?(?:[！。])?$/u.test(clause);
}

function hasHealthCertificateThirdPartySubject(clause: string): boolean {
  return /(?:公司|门店|你们|平台|单位|医院|社区)/u.test(clause) && /办(?:理)?/u.test(clause);
}

/**
 * 只识别同一分句内的办理流程/费用咨询。
 *
 * “能/会/可以”本身只是弱情态词；出现在“哪里能办”“公司会帮办吗”等问句时，
 * 不能升级成候选人接受办理。明确的“愿意/准备/入职前会去办”仍由承诺词优先放行。
 */
function isHealthCertificateConsultationClause(clause: string): boolean {
  if (!clause.includes('健康证')) return false;

  const hasDirectQuestion = HEALTH_CERTIFICATE_CONSULTATION_TERMS.some((term) =>
    clause.includes(term),
  );
  if (hasDirectQuestion) return true;

  const hasQuestionForm = isHealthCertificateQuestionForm(clause);
  const hasConsultationTopic = /免费|费用|收费|报销|补贴|线上|线下/u.test(clause);
  const hasWeakApplicationModal =
    /(?<![不没未无非])(?:能|会|可以|可)[^，,。！？?!；;\n]{0,12}办(?:理)?[^，,。！？?!；;\n]{0,8}健康证|健康证[^，,。！？?!；;\n]{0,16}(?<![不没未无非])(?:能|会|可以|可)[^，,。！？?!；;\n]{0,12}办(?:理)?/u.test(
      clause,
    );
  const hasThirdPartySubject = hasHealthCertificateThirdPartySubject(clause);

  return (
    hasThirdPartySubject ||
    (hasQuestionForm &&
      (hasConsultationTopic || hasWeakApplicationModal || /办(?:理)?/u.test(clause)))
  );
}

function extractDeclaredHealthCertificateStatus(clause: string): HealthCertificateFact | null {
  if (
    /健康证\s*[：:]\s*(?:无|没有)(?:$|[\s，,。；;])/u.test(clause) ||
    /(?<!有)(?:没有(?:食品|餐饮|零售)?(?:类)?健康证|没健康证|无健康证)/u.test(clause)
  ) {
    return '无';
  }
  if (
    /健康证.{0,6}(?:不是|非)本地|(?:外地|异地).{0,3}健康证|健康证.{0,4}(?:外地|异地)/u.test(clause)
  ) {
    return '非本地健康证';
  }
  return null;
}

function extractHealthCertificateClause(clause: string): HealthCertificateFact | null {
  const declaredStatus = extractDeclaredHealthCertificateStatus(clause);
  const hasThirdPartySubject = hasHealthCertificateThirdPartySubject(clause);
  const hasDirectConsultation = HEALTH_CERTIFICATE_CONSULTATION_TERMS.some((term) =>
    clause.includes(term),
  );

  // “能不能办 / 可不可以办”内部包含“不能办 / 不可以办”字面子串，必须先按
  // 固定咨询句式处理，不能让下方拒办正则截走。
  if (hasDirectConsultation) return declaredStatus;

  // 第三方“公司不会帮办”等咨询也含“不...会...办”。只有没有第三方主语时，
  // 才把拒办词视为候选人本人立场。
  if (
    !hasThirdPartySubject &&
    /(?:拒绝|没法|无法|(?:不|没|未)(?:太|怎么|很)?(?:接受|愿意|想|打算|准备|考虑|会|能|可以)).{0,24}(?:去|再)?(?:体检.{0,10})?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|不(?:去|再)?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|健康证.{0,24}(?:拒绝|没法|无法|(?:不|没|未)(?:太|怎么|很)?(?:接受|愿意|想|打算|准备|考虑|会|能|可以)).{0,12}(?:去|再)?办(?:理)?/u.test(
      clause,
    )
  ) {
    return '无且不接受办理健康证';
  }

  // 咨询只跳过当前分句；同句已明确“无证/异地证”时仍保留已声明状态。
  if (isHealthCertificateConsultationClause(clause)) return declaredStatus;

  // 生产口语常把意愿说成“后期去体检，然后办一个健康证”，而不使用标准的
  // “可以办健康证”。这类带明确将来/意愿动词的表述与标准枚举语义一致。
  if (
    !hasThirdPartySubject &&
    !isHealthCertificateQuestionForm(clause) &&
    /(?<![不没未无非])(?:接受|愿意|可以|可|能|会|打算|准备|考虑|确定|后期|后面|之后|到时|到时候|入职前|上岗前).{0,24}(?:去|再)?(?:体检.{0,10})?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|去体检.{0,12}办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|健康证.{0,30}(?<![不没未无非])(?:接受|愿意|可以|能|会|打算|准备|考虑|确定).{0,12}(?:去|再)?办(?:理)?/u.test(
      clause,
    )
  ) {
    return '无但接受办理健康证';
  }

  if (declaredStatus) return declaredStatus;

  // 疑问句守卫（badcase zj8b3rj1，chat 6a68622d：「都是需要有食品健康证是吗」是在问
  // 岗位要求，不是自报有证；缺此守卫时裸类型词命中「有」会让疑问句直通报名有证 gate）。
  // 岗位要求转述（"需要健康证"）同样不是持有声明。只挡「有」档，负向/意愿档在上方已返回。
  if (
    /健康证[^。！？\n]{0,8}(?:是吗|对吗|吗|么|吧|呢)|健康证[^。！？\n]{0,6}[？?]|(?:需要|要求|是不是要|要不要|用不用|必须|得)(?:先)?(?:有|办|持有?)?[^。！？\n]{0,8}健康证/u.test(
      clause,
    )
  ) {
    return null;
  }
  // 「有」必须是持有声明：有+证（可带类型词），或证+办好/拿到类完成表述；
  // 裸类型词（"食品健康证"仅被提及）不再视为持有证据。
  if (
    /有(?:食品|餐饮|零售)?(?:类)?健康证|本地.{0,4}健康证|健康证.{0,4}本地|(?:食品|餐饮|零售)?(?:类)?健康证.{0,6}(?:办好了?|办过|已办|办了|拿到|在手)/u.test(
      clause,
    )
  ) {
    return '有';
  }
  return null;
}

function extractHealthCertificate(message: string): string | null {
  if (!message.includes('健康证')) return null;

  let latestFact: HealthCertificateFact | null = null;
  let pendingClauses: string[] = [];
  let hasHealthCertificateTopic = false;

  for (const clause of splitHealthCertificateClauses(message)) {
    // “我没有健康证，可以去办/公司会帮我办吗”后半句常省略“健康证”。
    // 只有话题已出现且当前句仍带办理/费用线索时才继承，避免把后续无关的
    // “我本地人/材料办好了”误判为持有健康证。
    const mentionsHealthCertificate = clause.includes('健康证');
    const inheritsHealthCertificateTopic =
      hasHealthCertificateTopic &&
      ((isHealthCertificateQuestionForm(clause) &&
        /(?:费用|收费|报销|补贴|免费|线上|线下)/u.test(clause)) ||
        /(?:可以|可|能|会|愿意|接受|打算|准备|考虑|入职前|上岗前|后期|后面|之后|到时|到时候|公司|门店|你们|平台|单位|医院|社区).{0,16}(?:去|帮我|统一|负责)?办(?:理)?(?:一下|了)?(?:吗|么|呢)?[?？!！。；;，,]?$/u.test(
          clause,
        ) ||
        // 跨分句资质限定语：「我有健康证，但是外地的/是外地办的」——限定语分句里没有
        // "健康证"字样，不继承话题就永远够不到"非本地"判定（消息级正则改逐分句时引入
        // 的回归）。异地证按"有"直通会与 precheck「异地证一律不能按有提交」口径相撞。
        /(?:外地|异地|(?:不是|非)本地)/u.test(clause));
    const scopedClause = mentionsHealthCertificate
      ? clause
      : inheritsHealthCertificateTopic
        ? `健康证${clause}`
        : clause;
    if (mentionsHealthCertificate) hasHealthCertificateTopic = true;
    const directFact = extractHealthCertificateClause(scopedClause);

    if (directFact) {
      latestFact = directFact;
      pendingClauses = [];
      continue;
    }

    if (isHealthCertificateConsultationClause(scopedClause)) {
      // 咨询是边界，但不是事实：不能抹掉前面已经确认的承诺/拒绝/证件状态。
      pendingClauses = [];
      continue;
    }

    pendingClauses.push(clause);
    const pendingText = pendingClauses.join('');
    if (!pendingText.includes('健康证')) continue;

    // 兼容承诺跨多个逗号分句的口语，例如“如果面试上了，他后期会去体检，
    // 然后办一个健康证”。组合只包含连续非咨询分句，避免问句与立场串线。
    const bufferedFact = extractHealthCertificateClause(pendingText);
    if (bufferedFact) {
      latestFact = bufferedFact;
      pendingClauses = [];
    }
  }

  return latestFact;
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
  if (!message.includes('[位置分享]')) return [];

  const locations: string[] = [];
  const title = message.match(/\[位置分享\]\s*([^（\[]+)/)?.[1]?.trim();
  if (title) locations.push(title);

  const address = message.match(/（([^）]+)）/)?.[1]?.trim();
  if (address) locations.push(address);

  return Array.from(new Set(locations.filter(Boolean)));
}
