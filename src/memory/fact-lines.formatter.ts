import { isValidLaborForm } from '@resolution/labor-form';
import { stripTimeContextSuffix } from '@resolution/candidate/name';
import type { TurnHints, TurnHintFieldPath } from '@resolution/evidence/claim.types';
import { projectTurnHints, resolveTurnHints } from '@resolution/evidence/merge';
import { RULE_CLAIM_QUOTE_MAX_CHARS } from '@resolution/evidence/producers/direct-field';
import { formatLocalMinute } from '@infra/utils/date.util';
import type {
  EntityExtractionResult,
  SessionFacts,
  SessionFactValue,
} from './short-term/session-semantic/facts/facts.types';

export interface FactLineFormatOptions {
  /**
   * 是否在字段行内渲染 evidence。
   *
   * 默认 false：sessionFacts 侧的 evidence 可能是 LLM 轨的长文 reasoning，全文注入会
   * 把整段推理灌进上下文且逐字段重复（张漪 case 单轮 system prompt 被撑到 27K+ 字符）。
   *
   * 置 true 的两处都是**规则轨** claim 注入（事实提取 prompt 的 [规则模式匹配线索]、
   * 主 Agent prompt 的 [本轮解析线索]/[本轮待确认线索]，见 turn-hints.section）。
   * 规则轨安全的原因：evidence 是 `年龄识别：25` / `explicit_city` 这类短标签或机器码，
   * 不含长文；配套的 `原话` 片段也在 formatTurnHintLines 里按
   * RULE_CLAIM_QUOTE_RENDER_MAX_CHARS 截断、并对"整条当轮消息"省略渲染。
   * 长文 evidence 只出现在 LLM 轨/sessionFacts 侧，那里一律保持默认 false。
   */
  includeEvidence?: boolean;
  /**
   * 会话当前意向品牌（facts.brand.currentBrand.canonicalName）。
   *
   * preferences.brands 字段已退役（§19.6）：品牌唯一真相是 facts.brand，
   * 由调用方显式传入而非从 facts 里读——防止存储里收口前的旧值复活。
   * 不传则不渲染意向品牌行（如事实提取 prompt 的规则线索注入，无需品牌上下文）。
   */
  currentBrandName?: string | null;
}

/** 时间敏感字段超过该时长未更新时，渲染陈旧告警。 */
const STALE_FACT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * 把结构化提取结果渲染成统一字段列表。
 *
 * 供 session facts 渲染和 turn hints 渲染共用，避免重复维护字段顺序/文案。
 */
export function formatExtractionFactLines(
  facts: EntityExtractionResult | SessionFacts,
  options: FactLineFormatOptions = {},
): string[] {
  const { interview_info: info, preferences: pref } = facts;
  const lines: string[] = [];
  const meta = (value: unknown) => formatInlineFactMeta(value, options);

  const name = readFactValue(info.name);
  if (name) lines.push(`- 姓名: ${name}${meta(info.name)}`);

  const phone = readFactValue(info.phone);
  if (phone) lines.push(`- 联系方式: ${phone}${meta(info.phone)}`);

  const gender = readFactValue(info.gender);
  if (gender) {
    const genderSource = readFactValue(info.gender_source);
    const sourceTag =
      genderSource === 'candidate'
        ? '（候选人自陈）'
        : '（系统标签，未经候选人自陈，不得用于直接排除候选人）';
    lines.push(`- 性别: ${gender}${sourceTag}${meta(info.gender)}`);
  }

  const age = readFactValue(info.age);
  if (age) lines.push(`- 年龄: ${age}${meta(info.age)}`);

  const isStudent = readFactValue(info.is_student);
  if (isStudent != null)
    lines.push(`- 是否学生: ${isStudent ? '是' : '否'}${meta(info.is_student)}`);

  const education = readFactValue(info.education);
  if (education) lines.push(`- 学历: ${education}${meta(info.education)}`);

  const healthCertificate = readFactValue(info.has_health_certificate);
  if (healthCertificate)
    lines.push(`- 健康证: ${healthCertificate}${meta(info.has_health_certificate)}`);

  const experience = readFactValue(info.experience);
  if (experience) lines.push(`- 过往工作经历: ${experience}${meta(info.experience)}`);

  const uploadResume = readFactValue(info.upload_resume);
  if (uploadResume) lines.push(`- 简历附件: ${uploadResume}${meta(info.upload_resume)}`);

  const height = readFactValue(info.height);
  if (height) lines.push(`- 身高: ${height}${meta(info.height)}`);

  const weight = readFactValue(info.weight);
  if (weight) lines.push(`- 体重: ${weight}${meta(info.weight)}`);

  const householdProvince = readFactValue(info.household_register_province);
  if (householdProvince)
    lines.push(`- 户籍省份: ${householdProvince}${meta(info.household_register_province)}`);

  // 用工形式（全职/兼职/小时工/寒假工/暑假工）是筛选维度；历史脏值（正式工/临时工）被 isValidLaborForm 过滤。
  const laborForm = readFactValue(pref.labor_form);
  if (laborForm && isValidLaborForm(laborForm)) {
    lines.push(`- 用工形式: ${laborForm}${meta(pref.labor_form)}`);
  }
  if (options.currentBrandName) {
    lines.push(`- 意向品牌: ${options.currentBrandName}（来源: 会话品牌状态）`);
  }
  const brandIds = readFactValue(pref.brand_ids);
  if (brandIds?.length) lines.push(`- 意向品牌ID: ${brandIds.join('、')}${meta(pref.brand_ids)}`);
  const salary = readFactValue(pref.salary);
  if (salary) lines.push(`- 意向薪资: ${salary}${meta(pref.salary)}`);
  const position = readFactValue(pref.position);
  if (position?.length) lines.push(`- 意向岗位: ${position.join('、')}${meta(pref.position)}`);
  const schedule = readFactValue(pref.schedule);
  if (schedule) lines.push(`- 意向班次: ${schedule}${meta(pref.schedule)}`);
  const city = pref.city;
  if (isSessionFactValue(city)) {
    lines.push(`- 意向城市: ${city.value}${meta(city)}`);
  } else if (city?.value) {
    lines.push(`- 意向城市: ${city.value}（置信度: ${city.confidence}）`);
  }
  const district = readFactValue(pref.district);
  if (district?.length) lines.push(`- 意向区域: ${district.join('、')}${meta(pref.district)}`);
  const location = readFactValue(pref.location);
  if (location?.length) lines.push(`- 意向地点: ${location.join('、')}${meta(pref.location)}`);
  const delayedIntent = readFactValue(pref.delayed_intent);
  if (delayedIntent)
    lines.push(
      `- 推迟意向: ${delayedIntent.until}（原话: ${delayedIntent.raw}）${meta(pref.delayed_intent)}${formatStaleness(pref.delayed_intent)}`,
    );
  const shortTerm = readFactValue(pref.short_term);
  if (shortTerm != null)
    lines.push(`- 短期工意向: ${shortTerm ? '是' : '否'}${meta(pref.short_term)}`);
  const openPosition = readFactValue(pref.open_position);
  if (openPosition != null)
    lines.push(`- 岗位开放: ${openPosition ? '是' : '否'}${meta(pref.open_position)}`);
  const timeWindows = readFactValue(pref.time_windows);
  if (timeWindows?.length)
    lines.push(`- 可用时间窗口: ${timeWindows.join('、')}${meta(pref.time_windows)}`);
  const scheduleConstraint = readFactValue(pref.schedule_constraint);
  if (scheduleConstraint) {
    const parts: string[] = [];
    if (scheduleConstraint.onlyWeekends) parts.push('只周末');
    if (scheduleConstraint.onlyEvenings) parts.push('只晚班');
    if (scheduleConstraint.onlyMornings) parts.push('只早班');
    if (scheduleConstraint.maxDaysPerWeek)
      parts.push(`每周最多${scheduleConstraint.maxDaysPerWeek}天`);
    if (parts.length)
      lines.push(`- 结构化排班约束: ${parts.join('、')}${meta(pref.schedule_constraint)}`);
  }
  const availableAfter = readFactValue(pref.available_after);
  if (availableAfter)
    lines.push(
      `- 最早可面试日期: ${availableAfter.date}（原话: ${availableAfter.raw}）${meta(pref.available_after)}`,
    );

  return lines;
}

function readFactValue<T>(value: SessionFactValue<T> | T | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  return isSessionFactValue(value) ? value.value : value;
}

function formatInlineFactMeta(value: unknown, options: FactLineFormatOptions): string {
  if (!isSessionFactValue(value)) return '';
  const parts = [`置信度: ${value.confidence}`, `来源: ${value.source}`];
  if (options.includeEvidence && value.evidence?.trim()) {
    parts.push(`证据: ${value.evidence}`);
  }
  return `（${parts.join('，')}）`;
}

/**
 * 时间敏感字段的陈旧标注。
 *
 * 面试时间/应聘门店等事务性字段常以相对表述（"明天下午2点"）被提取，跨天后语义漂移。
 * 张漪 case：6-03 的"明天下午2点"在 6-10 仍作为"候选人已知信息"注入，模型无从判断
 * 这是 7 天前的"明天"。记录时间超过 24h 即显式告警。
 */
function formatStaleness(value: unknown): string {
  if (!isSessionFactValue(value)) return '';
  const extractedAt = (value as SessionFactValue<unknown>).extractedAt;
  if (!extractedAt) return '';
  const recordedMs = Date.parse(extractedAt);
  if (!Number.isFinite(recordedMs)) return '';

  const recordedAt = formatLocalMinute(new Date(recordedMs));
  if (Date.now() - recordedMs < STALE_FACT_THRESHOLD_MS) {
    return `（记录时间：${recordedAt}）`;
  }
  return `（⚠️记录时间：${recordedAt}；其中的相对时间表述以该记录时间为基准，可能已失效，使用前必须与候选人确认）`;
}

function isSessionFactValue(value: unknown): value is SessionFactValue<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'confidence' in value &&
    'source' in value &&
    'evidence' in value
  );
}

const FACT_LINE_FIELD_BY_LABEL: Readonly<Record<string, TurnHintFieldPath>> = {
  姓名: 'interview_info.name',
  联系方式: 'interview_info.phone',
  性别: 'interview_info.gender',
  年龄: 'interview_info.age',
  是否学生: 'interview_info.is_student',
  学历: 'interview_info.education',
  健康证: 'interview_info.has_health_certificate',
  过往工作经历: 'interview_info.experience',
  简历附件: 'interview_info.upload_resume',
  身高: 'interview_info.height',
  体重: 'interview_info.weight',
  户籍省份: 'interview_info.household_register_province',
  用工形式: 'preferences.labor_form',
  意向薪资: 'preferences.salary',
  意向岗位: 'preferences.position',
  意向班次: 'preferences.schedule',
  意向城市: 'preferences.city',
  意向区域: 'preferences.district',
  意向地点: 'preferences.location',
  结构化排班约束: 'preferences.schedule_constraint',
  最早可面试日期: 'preferences.available_after',
};

/**
 * 规则 claim 的原话片段渲染上限。
 *
 * quote 默认取整条候选人消息（上限 1000 字，见 direct-field.RULE_CLAIM_QUOTE_MAX_CHARS），
 * 逐字段渲染会把同一条消息重复 N 遍。这里只保留足以定位来源句的开头。
 */
export const RULE_CLAIM_QUOTE_RENDER_MAX_CHARS = 40;

export interface TurnHintLineOptions extends Pick<FactLineFormatOptions, 'includeEvidence'> {
  /**
   * 是否在 evidence 之后追加候选人逐字原话片段。
   *
   * 默认 false，只有主 Agent prompt 的 [本轮解析线索]/[本轮待确认线索] 置 true：
   * 事实提取 prompt 的 [规则模式匹配线索] 与提取 LLM 共享同一份对话原文，无需重复注入。
   */
  includeQuote?: boolean;
  /**
   * 本轮候选人消息原文（逐条，与规则轨输入同源）。
   *
   * 用于判定 quote 是否"就是整条当轮消息"：单消息轮里那样的 quote 没有信息量
   * （模型本来就看得到当轮消息），渲染出来只是重复注入；合并多条消息的轮次才需要
   * 用原话指明该 claim 来自哪一条。不传则按"无法判定"处理，只渲染精确命中片段。
   */
  currentTurnTexts?: readonly string[];
}

/**
 * 直接从 claim 流渲染规则线索；元数据来自最终获选 claim，不制造中间包装值。
 *
 * `includeEvidence` 下除了 `证据`（解析结论的机器码/中文标签）还会渲染 `原话`
 * （候选人逐字片段）：`证据` 只是把结论重说一遍——候选人复述岗位要求
 * （"这岗位要求18-45岁"）时渲染出的 `证据: 年龄识别：18-45` 不含任何"这句在讲岗位要求"
 * 的信号，而这正是本段文案点名要模型防的两类误判之一（core-flow-review 议题 2-1）。
 */
export function formatTurnHintLines(
  facts: TurnHints | null | undefined,
  options: TurnHintLineOptions = {},
): string[] {
  const projected = projectTurnHints(facts);
  if (!projected) return [];
  const resolved = new Map(resolveTurnHints(facts).map((fact) => [fact.field, fact]));
  return formatExtractionFactLines(projected).map((line) => {
    const label = /^- ([^:]+):/u.exec(line)?.[1];
    const field = label ? FACT_LINE_FIELD_BY_LABEL[label] : undefined;
    const fact = field ? resolved.get(field) : undefined;
    if (!fact) return line;
    const parts = [`置信度: ${fact.confidence}`, `来源: ${fact.producer}`];
    if (options.includeEvidence) {
      parts.push(`证据: ${fact.evidence.code ?? fact.evidence.label}`);
      if (options.includeQuote) {
        const quote = renderClaimQuote(fact.evidence.quote, options.currentTurnTexts);
        if (quote) parts.push(`原话: ${quote}`);
      }
    }
    const meta = `（${parts.join('，')}）`;
    return field === 'preferences.city'
      ? line.replace(/（置信度: (?:high|medium|low)）$/u, meta)
      : `${line}${meta}`;
  });
}

/**
 * 决定是否渲染 quote，以及渲染成什么。
 *
 * - quote 是消息里的精确命中片段 → 一律渲染（"这句在讲什么"的唯一信号）；
 * - quote 等于某条当轮消息全文 → 只有合并轮（当轮 >1 条消息）才渲染，用来指明来自哪条；
 *   单消息轮省略（模型看得到当轮消息，逐字段重复注入同一条消息纯属浪费上下文）。
 */
function renderClaimQuote(
  quote: string | undefined,
  currentTurnTexts: readonly string[] | undefined,
): string | null {
  const trimmed = quote?.trim();
  if (!trimmed) return null;
  if (currentTurnTexts?.length) {
    const isWholeMessage = currentTurnTexts.some(
      (text) => normalizeClaimQuoteSource(text) === trimmed,
    );
    if (isWholeMessage && currentTurnTexts.length === 1) return null;
  }
  return trimmed.length > RULE_CLAIM_QUOTE_RENDER_MAX_CHARS
    ? `${trimmed.slice(0, RULE_CLAIM_QUOTE_RENDER_MAX_CHARS)}…`
    : trimmed;
}

/** 与 rule-track appendRuleClaim 存 quote 时的归一化保持一致，否则全等比对必失效。 */
function normalizeClaimQuoteSource(text: string): string {
  return stripTimeContextSuffix(text).trim().slice(0, RULE_CLAIM_QUOTE_MAX_CHARS);
}
