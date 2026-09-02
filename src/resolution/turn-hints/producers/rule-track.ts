import type { BrandItem } from '@/sponge/sponge.types';
import { formatLocalDate } from '@infra/utils/date.util';
import { stripQuotedBlocks as stripQuotedBlocksMarkup } from '@resolution/signal/markers';
import {
  extractStructuredName as extractCandidateStructuredName,
  extractStructuredNameMatch as extractCandidateStructuredNameMatch,
  normalizeGenderValue as normalizeCandidateGenderValue,
  parseAge as parseCandidateAge,
  parseEducation as parseCandidateEducation,
  parseGender as parseCandidateGender,
  parseHealthCertificateMatch as parseCandidateHealthCertificateMatch,
  parseHeight as parseCandidateHeight,
  parseHouseholdProvince as parseCandidateHouseholdProvince,
  parsePhone as parseCandidatePhone,
  parseWeight as parseCandidateWeight,
  stripTimeContextSuffix,
} from '@resolution/candidate';
import type { CandidateParseResult } from '@resolution/candidate/types';
import { matchIdentityStatement } from '@resolution/candidate/student-identity';
import { decideLaborFormIntent } from '@resolution/labor-form';
import { fieldValues, type FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { resolveExtractionScope } from '../admission';
import type {
  TurnHint,
  TurnHints,
  TurnHintConfidence,
  TurnHintFieldPath,
} from '../turn-hint.types';
import { TURN_HINT_FIELD_POLICIES } from '../policies';
import { produceBrandAliasHints, type BrandAliasHint } from '@resolution/brand/intent-producer';
import {
  extractAvailableAfterDate,
  extractLaborForm,
  extractLocation,
  extractPositions,
  extractSalary,
  extractSchedule,
  extractScheduleConstraintStructured,
} from './rule-track-preferences';

export type { BrandAliasHint } from '@resolution/brand/intent-producer';

/**
 * 剥离引用消息块，只保留候选人自己写的内容。
 *
 * 被引用内容通常是招募经理发的岗位描述，其中的年龄/班次/薪资等数值属于岗位要求，
 * 不是候选人自陈——必须在规则提取前剥离，否则所有 extract* 函数都会误提取引用块内的
 * 实体（品牌解析同理：引用块里的品牌是经理的话）。
 *
 * 标记形态（`[引用 XXX：…]` / 行首 `引用 XXX：`）见 @resolution/signal/markers；
 * 此处保留具名转出，因为 6 个提取路径消费的是"提取前先剥引用"这条语义。
 */
export const stripQuotedBlocks = stripQuotedBlocksMarkup;

// ── per-field 提取器注册表 ───────────────────────────────────────────────────

type FieldGroup = 'interview_info' | 'preferences';

/** 规则提示引用的截断上限；提取输入与保存的引用必须完全一致。 */
export const RULE_HINT_QUOTE_MAX_CHARS = 1000;

/**
 * 单字段提取器声明（无字段间联动）。
 *
 * 设计目标：把"提取函数 → 主循环八股 → 各处镜像清单"的六处散布收敛到一处。
 * 新增一个普通字段只需在 FIELD_EXTRACTORS 追加一项，主循环、字段完备性校验
 * 自动覆盖；带联动/自定义合并的字段（gender、is_student、schedule_constraint、
 * city/district/location、brands、available_after）不强塞进来，保留在循环内手写。
 *
 * producer 对每条命中都发 claim；first/last/union/composite 只能由
 * policies.ts 声明并由 evidence/merge 执行。
 */
interface FieldExtractor {
  group: FieldGroup;
  field: string;
  extract: (message: string) => string | string[] | CandidateParseResult<string | string[]> | null;
  /** evidence 文案（入库到字段元数据，服务排障）。 */
  evidence: (value: string) => string;
  /** reasoning 文案（拼进对外 reasoning 串）；缺省与 evidence 同文。 */
  reason?: (value: string) => string;
}

function isCandidateParseResult(
  value: string | string[] | CandidateParseResult<string | string[]>,
): value is CandidateParseResult<string | string[]> {
  return typeof value === 'object' && !Array.isArray(value) && 'value' in value;
}

const FIELD_EXTRACTORS: FieldExtractor[] = [
  {
    group: 'interview_info',
    field: 'name',
    extract: extractStructuredNameWithEvidence,
    evidence: (value) => `结构化姓名识别：${value}`,
    reason: (value) => `结构化姓名识别：${value}（来源：收资表单键值对）`,
  },
  {
    group: 'interview_info',
    field: 'phone',
    extract: extractPhone,
    evidence: (value) => `手机号识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'age',
    extract: extractAge,
    evidence: (value) => `年龄识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'has_health_certificate',
    // 证件状态会随候选人补充意愿而演进：旧“无”必须能被最新“愿意办理”覆盖，
    // 最新明确拒绝也必须反向覆盖旧承诺。
    extract: extractHealthCertificate,
    evidence: (value) => `健康证识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'experience',
    extract: extractExperience,
    evidence: (value) => `工作经历识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'upload_resume',
    extract: extractUploadResume,
    evidence: (value) => `简历附件识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'height',
    extract: extractHeight,
    evidence: (value) => `身高识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'weight',
    extract: extractWeight,
    evidence: (value) => `体重识别：${value}`,
  },
  {
    group: 'interview_info',
    field: 'household_register_province',
    extract: extractHouseholdRegisterProvince,
    evidence: (value) => `户籍识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'labor_form',
    extract: extractLaborForm,
    evidence: (value) => `用工形式识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'salary',
    extract: extractSalary,
    evidence: (value) => `薪资识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'schedule',
    extract: extractSchedule,
    evidence: (value) => `班次识别：${value}`,
  },
  {
    group: 'preferences',
    field: 'position',
    extract: extractPositions,
    evidence: (value) => `岗位识别：${value}`,
  },
];

/** 注册表声明的字段清单：供下游镜像清单做编译期/测试期完备性校验。 */
export const REGISTRY_FIELD_PATHS: readonly TurnHintFieldPath[] = FIELD_EXTRACTORS.map(
  (extractor) => `${extractor.group}.${extractor.field}` as TurnHintFieldPath,
);

interface RuleClaimSink {
  claims: TurnHint[];
  reasons: string[];
  assertedAt: string;
  sequence: number;
}

interface AppendRuleClaimParams {
  field: TurnHintFieldPath;
  value: unknown;
  message: string;
  /** 解析器已知的精确命中片段；缺失时才回退整条候选人消息。 */
  quote?: string;
  label: string;
  reason?: string;
  confidence?: TurnHintConfidence;
  evidenceCode?: string;
  operation?: 'set' | 'clear';
  clearValues?: readonly unknown[];
  producer?: TurnHint['producer'];
}

function appendRuleClaim(sink: RuleClaimSink, params: AppendRuleClaimParams): void {
  const producer = params.producer ?? 'rule';
  sink.sequence += 1;
  sink.claims.push({
    claimId: `${producer}_${params.field.replace('.', '_')}_${sink.sequence}`,
    field: params.field,
    value: params.operation === 'clear' ? null : params.value,
    operation: params.operation ?? 'set',
    producer,
    interpretation: 'direct',
    confidence: params.confidence ?? 'high',
    evidence: {
      quote: stripTimeContextSuffix(params.quote ?? params.message)
        .trim()
        .slice(0, RULE_HINT_QUOTE_MAX_CHARS),
      label: params.label,
      ...(params.evidenceCode ? { code: params.evidenceCode } : {}),
    },
    ...(params.clearValues ? { clearValues: params.clearValues } : {}),
    reasoning: params.reason ?? params.label,
    assertedAt: sink.assertedAt,
  });
  sink.reasons.push(params.reason ?? params.label);
}

function applyFieldExtractor(
  extractor: FieldExtractor,
  message: string,
  sink: RuleClaimSink,
): void {
  const toReason = extractor.reason ?? extractor.evidence;
  const field = `${extractor.group}.${extractor.field}` as TurnHintFieldPath;

  if (extractor.field === 'labor_form') {
    const intent = decideLaborFormIntent(message);
    if (intent.kind === 'ignore') return;
    if (intent.kind === 'clear') {
      appendRuleClaim(sink, {
        field,
        value: null,
        message,
        label: `用工形式清除：${intent.clearedValues.join('、')}`,
        operation: 'clear',
        clearValues: intent.clearedValues,
      });
      return;
    }
  }

  const extracted = extractor.extract(message);
  if (extracted === null) return;
  const isEvidenceResult = isCandidateParseResult(extracted);
  const value = isEvidenceResult ? extracted.value : extracted;
  if (Array.isArray(value) && value.length === 0) return;
  const label = Array.isArray(value) ? value.join('、') : value;
  appendRuleClaim(sink, {
    field,
    value,
    message,
    quote: isEvidenceResult ? extracted.excerpt : undefined,
    label: extractor.evidence(label),
    reason: toReason(label),
  });
}

// 提取授权域（kind → identity/phone/preferences/geo）已收拢至
// @resolution/turn-hints/admission：规则只由 sheet kind 决定，与消费点无关，
// 且在域内有 Record<VisualFactKind,…> 的加档编译期约束。

export interface ProduceTurnHintsOptions {
  /** 剥时间后缀内容 → sheet 的映射（visual-fact-structuring 消费侧读路径）。 */
  visualSheetsByContent?: ReadonlyMap<string, FinalizedVisualFactSheet>;
}

export function produceTurnHints(
  userMessages: string[],
  brandData: BrandItem[],
  options?: ProduceTurnHintsOptions,
): TurnHints | null {
  const normalizedMessages = userMessages
    .map((message) => stripQuotedBlocks(message.trim()))
    .filter(Boolean);
  if (normalizedMessages.length === 0) return null;

  const sink: RuleClaimSink = {
    claims: [],
    reasons: [],
    assertedAt: new Date().toISOString(),
    sequence: 0,
  };
  // 查表键必须剥时间后缀（评审阻断项）：map 键是 DB 原始内容（无后缀），
  // 而生产窗口消息带 injectTimeContext 注入的 `\n[消息发送时间：…]` 后缀——不剥则
  // 查表永远 miss，sheet 授权域静默失效、全部回落文本兜底（测试曾因 fixture 无后缀漏过）。
  const sheetFor = (message: string): FinalizedVisualFactSheet | undefined =>
    options?.visualSheetsByContent?.get(stripTimeContextSuffix(message).trim());

  // 品牌收口（§9.2）：本函数不内联直写 preferences.brands——品牌真相唯一存储是
  // facts.brand（写入只经 reducer），preferences.brands 已退役、读边界恒 null。
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
    sink.reasons.push(
      ...aliasHints.map(
        (hint) =>
          `品牌别名识别：用户原话"${hint.sourceText}"命中"${hint.matchedAlias}" => "${hint.brandName}"`,
      ),
    );
  }

  // 自陈收窄（badcase vkikct39）：候选人转发的第三方岗位截图，其 vision
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
      applyFieldExtractor(extractor, message, sink);
    }

    // ── 以下为带字段间联动 / 自定义合并语义的特殊字段，保留在循环内手写 ──

    // gender：候选人原话经确定性规则复算后，来源章直接记 candidate_quote；
    // 岗位截图里的"仅限男"仍不是候选人性别。
    const gender = isSelfReported ? extractGender(message) : null;
    if (gender) {
      appendRuleClaim(sink, {
        field: 'interview_info.gender',
        value: gender.value,
        message,
        quote: gender.excerpt,
        label: `性别识别：${gender.value}`,
        producer: 'candidate_quote',
      });
    }

    // is_student + education：一次 extractStudentInfo 同时产出两个字段（且 is_student 走
    // boolean null 判定，education 在缺失时还有 extractEducation 兜底），强耦合不拆。
    // 同属身份字段：岗位截图里的"限在校大学生/大专以上"是岗位要求，不是候选人学历。
    const studentInfo = isSelfReported
      ? extractStudentInfo(message)
      : { isStudent: null, education: null, educationExcerpt: null };
    if (studentInfo.isStudent !== null) {
      appendRuleClaim(sink, {
        field: 'interview_info.is_student',
        value: studentInfo.isStudent,
        message,
        label: `学生身份识别：${studentInfo.isStudent ? '是' : '否'}`,
      });
    }
    if (studentInfo.education) {
      appendRuleClaim(sink, {
        field: 'interview_info.education',
        value: studentInfo.education,
        message,
        quote: studentInfo.educationExcerpt ?? undefined,
        label: `学历识别：${studentInfo.education}`,
      });
    } else if (!studentInfo.education && scope.identity) {
      // 兜底路径同受身份域门控（评审阻断项）：岗位截图"学历要求：大专以上"不得入档
      const explicitEducation = extractEducation(message);
      if (explicitEducation) {
        appendRuleClaim(sink, {
          field: 'interview_info.education',
          value: explicitEducation.value,
          message,
          quote: explicitEducation.excerpt,
          label: `学历识别：${explicitEducation.value}`,
        });
      }
    }

    const scheduleConstraint = scope.preferences
      ? extractScheduleConstraintStructured(message)
      : null;
    if (scheduleConstraint) {
      const labelParts: string[] = [];
      if (scheduleConstraint.onlyWeekends) labelParts.push('只周末');
      if (scheduleConstraint.onlyEvenings) labelParts.push('只晚班');
      if (scheduleConstraint.onlyMornings) labelParts.push('只早班');
      if (scheduleConstraint.maxDaysPerWeek !== null) {
        labelParts.push(`每周≤${scheduleConstraint.maxDaysPerWeek}天`);
      }
      const label = `班次硬约束（结构化）：${labelParts.join('、') || '空'}`;
      appendRuleClaim(sink, {
        field: 'preferences.schedule_constraint',
        value: scheduleConstraint,
        message,
        label,
      });
    }

    const availableAfter = scope.preferences
      ? extractAvailableAfterDate(message, formatLocalDate(new Date()))
      : null;
    if (availableAfter) {
      appendRuleClaim(sink, {
        field: 'preferences.available_after',
        value: availableAfter,
        message,
        label: `未来日期硬约束：${availableAfter.date}`,
        reason: `未来日期硬约束：${availableAfter.date}（原话："${availableAfter.raw}"）`,
      });
    }

    const location = scope.geo
      ? extractLocation(message)
      : { city: null, district: [], location: [] };
    if (location.city) {
      appendRuleClaim(sink, {
        field: 'preferences.city',
        value: location.city.value,
        message,
        label: `城市识别：${location.city.value}`,
        confidence: location.city.confidence,
        evidenceCode: location.city.evidence,
        reason: `城市识别：${location.city.value}（证据：${location.city.evidence}，置信：${location.city.confidence}）`,
      });
    }
    if (location.district.length > 0) {
      appendRuleClaim(sink, {
        field: 'preferences.district',
        value: location.district,
        message,
        label: `区域识别：${location.district.join('、')}`,
      });
    }
    if (location.location.length > 0) {
      appendRuleClaim(sink, {
        field: 'preferences.location',
        value: location.location,
        message,
        label: `地点识别：${location.location.join('、')}`,
      });
    }
  }

  if (sink.claims.length === 0) return null;

  return {
    claims: sink.claims,
    reasoning: sink.reasons.length > 0 ? sink.reasons.join('\n') : '本轮前置规则识别',
  };
}

/**
 * 品牌别名命中提示（常设：提取提示词 [规则模式匹配线索] 的品牌线索唯一产出层）。
 *
 * 匹配主体已迁入 `resolution/brand`（§5.1 单一居所），本函数消费新解析结果、
 * 保持旧接口与输出形态兼容：提及级线索（不区分极性——"不要肯德基"仍产出肯德基的
 * 归一化线索，极性语义由 facts.brand reducer 消费 resolveBrands 原始结果处理），
 * 品类兜底行为不回归（已上线的咖啡品类召回）。
 *
 * 引用块在**本函数内**剥离，不依赖调用方：引用块里的品牌是招募经理/Agent 的话，
 * 不是候选人自陈。生产实例 6a5f21ef——候选人引用 Agent 的
 * 「零售群是超市、便利店、门店导购这类」，"便利店"命中品牌"7-11便利店"并进入
 * 提取提示词，形成 Agent 说品牌 → 候选人引用 → 品牌被当作其兴趣的自污染回路。
 * 根因是调用方（session.service extractFacts）传了原始消息，而剥离契约只写在
 * stripQuotedBlocks 的注释里、无结构约束。收进入口后调用方无法再漏（幂等，
 * rule-track claim 生产侧已剥过一次也无副作用）。
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
 * 把外部补充的性别追加到同一条规则 claim 流。
 *
 * 外部标签保持 low/system，不会被只消费 high 的 admission 路径误当成候选人自陈。
 */
export function mergeSupplementalGenderClaims(
  existing: TurnHints | null,
  gender: '男' | '女',
  sourceLabel: string,
): TurnHints {
  const sink: RuleClaimSink = {
    claims: [...(existing?.claims ?? [])],
    reasons: [],
    assertedAt: new Date().toISOString(),
    sequence: existing?.claims.length ?? 0,
  };
  appendRuleClaim(sink, {
    field: 'interview_info.gender',
    value: gender,
    message: sourceLabel,
    label: `${sourceLabel}补充性别：${gender}`,
    confidence: 'low',
    producer: 'system',
  });
  const suffix = `${sourceLabel}补充性别：${gender}`;
  return {
    claims: sink.claims,
    reasoning: [existing?.reasoning?.trim(), suffix].filter(Boolean).join('；'),
  };
}

/** 注册表字段必须在唯一策略表登记；producer 不再维护任何投影镜像。 */
function assertRegistryFieldsHavePolicy(): void {
  const missing = REGISTRY_FIELD_PATHS.filter(
    (field) => !Object.prototype.hasOwnProperty.call(TURN_HINT_FIELD_POLICIES, field),
  );
  if (missing.length > 0) {
    throw new Error(`[turn-hints] 注册表字段未登记策略：${missing.join(', ')}`);
  }
}

assertRegistryFieldsHavePolicy();

/**
 * 结构化收资表单中的"姓名：XX"键值对提取。
 *
 * 与 @resolution/candidate/name 的 hasStructuredNameSubmission 共用同一匹配逻辑，
 * 但定位不同：这里是"正向提取"（上游锚定），name-guard 是"事后救援"（下游补漏）。
 * 提取后经 isLikelyRealChineseName 校验，拦截昵称/乱码等非真名。
 */
export function extractStructuredName(message: string): string | null {
  return extractCandidateStructuredName(message);
}

function extractStructuredNameWithEvidence(message: string): CandidateParseResult<string> | null {
  return extractCandidateStructuredNameMatch(message);
}

function extractPhone(message: string): CandidateParseResult<string> | null {
  return parseCandidatePhone(message);
}

/**
 * 身高提取：候选人主动给出或表单回填「身高：170 / 身高 175cm」→ 数字字符串。
 *
 * 与 STRUCTURED_NAME_REGEX 同构的键值对模式：值取紧跟标签的 2-3 位数字，
 * 落在合理人类身高区间（100-250cm）才接受，避免「身高要求165以上」这类岗位
 * 要求被误捕——要求/限制语境（要求/限/需/不低于/以上/以下）一律不提取。
 */
function extractHeight(message: string): CandidateParseResult<string> | null {
  const result = parseCandidateHeight(message);
  return result === null ? null : { value: String(result.value), excerpt: result.excerpt };
}

/**
 * 体重提取：候选人主动给出或表单回填「体重：60 / 体重 60kg」→ 数字字符串。
 *
 * 同身高，落在合理区间（30-200kg）才接受；要求/限制语境一律不提取。
 */
function extractWeight(message: string): CandidateParseResult<string> | null {
  const result = parseCandidateWeight(message);
  return result === null ? null : { value: String(result.value), excerpt: result.excerpt };
}

/**
 * 户籍省份提取（敏感字段）：仅接受表单回填的键值对形态「户籍：安徽 / 籍贯：四川省」。
 *
 * 不做自由文本推断（"我是安徽人"不提取），值延伸到行尾，经省份白名单校验后返回。
 */
function extractHouseholdRegisterProvince(message: string): CandidateParseResult<string> | null {
  return parseCandidateHouseholdProvince(message);
}

function extractAge(message: string): CandidateParseResult<string> | null {
  const result = parseCandidateAge(message);
  return result === null ? null : { value: String(result.value), excerpt: result.excerpt };
}

function extractGender(message: string): CandidateParseResult<string> | null {
  return parseCandidateGender(message);
}

function extractStudentInfo(message: string): {
  isStudent: boolean | null;
  education: string | null;
  educationExcerpt: string | null;
} {
  if (/本科在读/.test(message)) {
    return { isStudent: true, education: '本科', educationExcerpt: '本科在读' };
  }
  const master = /硕士在读|研究生在读|研一|研二|研三/.exec(message);
  if (master) {
    return { isStudent: true, education: '硕士', educationExcerpt: master[0] };
  }
  const doctor = /博士在读|博一|博二|博三/.exec(message);
  if (doctor) {
    return { isStudent: true, education: '博士', educationExcerpt: doctor[0] };
  }
  const futureMaster =
    /考上研究生|研究生.*录取|录取.*研究生|准研究生|待入学|准备读研|读研|上研/.exec(message);
  if (futureMaster) {
    return { isStudent: true, education: '硕士', educationExcerpt: futureMaster[0] };
  }
  const identity = matchIdentityStatement(message);
  const education = parseCandidateEducation(message);
  return {
    isStudent: identity === null ? null : identity === '学生',
    education: education?.value ?? null,
    educationExcerpt: education?.excerpt ?? null,
  };
}

function extractEducation(message: string): CandidateParseResult<string> | null {
  return parseCandidateEducation(message);
}

function extractHealthCertificate(message: string): CandidateParseResult<string> | null {
  return parseCandidateHealthCertificateMatch(message);
}

function extractExperience(message: string): string | null {
  const labeled = message.match(
    /(?:过往公司\+岗位\+年限|工作经历|工作经验|近一段工作经历)\s*[：:]\s*([^\n\r]+)/u,
  )?.[1];
  if (labeled) return sanitizeExperienceText(labeled);

  // 时长里的空白只允许行内空格/制表符：`\s` 会吃掉 `\n`，让匹配跨行拼接。
  // 候选人按收资模板换行回填时（"电话…\n年龄22"），跨行匹配会把手机号尾数与下一行的
  // "年"拼成 experience="电话…年"，并随 precheck 模板渲染出去。
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
  // 第二道门：任何含手机号的结果都不应作为工作经历入档，否则会随 booking 的
  // “过往公司+岗位+年限”字段提交到工单。只按手机号形态拒绝，不按“电话/手机”
  // 标签词拒绝，因为“手机店”“电话客服”仍可能是合法经历。
  // 上方空白归一化会把换行两侧数字粘连，所以这里不能只依赖要求手机号两侧非数字的
  // parseCandidatePhone。
  if (parseCandidatePhone(text) || /1[3-9]\d{9}/.test(text)) return null;
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
