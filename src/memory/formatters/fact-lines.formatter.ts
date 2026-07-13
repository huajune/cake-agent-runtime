import { isValidLaborForm } from '../facts/labor-form';
import type {
  EntityExtractionResult,
  HighConfidenceFacts,
  HighConfidenceValue,
  SessionFacts,
  SessionFactValue,
} from '../types/session-facts.types';

export interface FactLineFormatOptions {
  /**
   * 是否在字段行内渲染 evidence 全文。
   *
   * 默认 false：Agent prompt 注入只带（置信度/来源），evidence 是排障字段，
   * 全文注入会把提取 reasoning 整段灌进上下文且逐字段重复（张漪 case 单轮
   * system prompt 被撑到 27K+ 字符）。
   * 仅事实提取 prompt 的 [规则模式匹配线索] 注入需要置 true——那里的 evidence
   * 是"手机号识别：135xx"这类短线索，是提取 LLM 的判断依据。
   */
  includeEvidence?: boolean;
}

/** 时间敏感字段超过该时长未更新时，渲染陈旧告警。 */
const STALE_FACT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * 把结构化提取结果渲染成统一字段列表。
 *
 * 供 session facts 渲染和 turn hints 渲染共用，避免重复维护字段顺序/文案。
 */
export function formatExtractionFactLines(
  facts: EntityExtractionResult | HighConfidenceFacts | SessionFacts,
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

  const appliedStore = readFactValue(info.applied_store);
  if (appliedStore)
    lines.push(
      `- 应聘门店: ${appliedStore}${meta(info.applied_store)}${formatStaleness(info.applied_store)}`,
    );

  const appliedPosition = readFactValue(info.applied_position);
  if (appliedPosition)
    lines.push(
      `- 应聘岗位: ${appliedPosition}${meta(info.applied_position)}${formatStaleness(info.applied_position)}`,
    );

  const interviewTime = readFactValue(info.interview_time);
  if (interviewTime)
    lines.push(
      `- 面试时间: ${interviewTime}${meta(info.interview_time)}${formatStaleness(info.interview_time)}`,
    );

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
  const brands = readFactValue(pref.brands);
  if (brands?.length) lines.push(`- 意向品牌: ${brands.join('、')}${meta(pref.brands)}`);
  const brandIds = readFactValue(pref.brand_ids);
  if (brandIds?.length) lines.push(`- 意向品牌ID: ${brandIds.join('、')}${meta(pref.brand_ids)}`);
  const salary = readFactValue(pref.salary);
  if (salary) lines.push(`- 意向薪资: ${salary}${meta(pref.salary)}`);
  const position = readFactValue(pref.position);
  if (position?.length) lines.push(`- 意向岗位: ${position.join('、')}${meta(pref.position)}`);
  const schedule = readFactValue(pref.schedule);
  if (schedule) lines.push(`- 意向班次: ${schedule}${meta(pref.schedule)}`);
  const city = pref.city;
  if (isInlineHighConfidenceValue(city)) {
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

function readFactValue<T>(
  value: HighConfidenceValue<T> | SessionFactValue<T> | T | null | undefined,
): T | null {
  if (value === null || value === undefined) return null;
  return isInlineHighConfidenceValue(value) ? value.value : value;
}

function formatInlineFactMeta(value: unknown, options: FactLineFormatOptions): string {
  if (!isInlineHighConfidenceValue(value)) return '';
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
  if (!isInlineHighConfidenceValue(value)) return '';
  const extractedAt = (value as SessionFactValue<unknown>).extractedAt;
  if (!extractedAt) return '';
  const recordedMs = Date.parse(extractedAt);
  if (!Number.isFinite(recordedMs)) return '';

  const recordedAt = formatBeijingDateTime(recordedMs);
  if (Date.now() - recordedMs < STALE_FACT_THRESHOLD_MS) {
    return `（记录时间：${recordedAt}）`;
  }
  return `（⚠️记录时间：${recordedAt}；其中的相对时间表述以该记录时间为基准，可能已失效，使用前必须与候选人确认）`;
}

function formatBeijingDateTime(timestampMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

function isInlineHighConfidenceValue(
  value: unknown,
): value is HighConfidenceValue<unknown> | SessionFactValue<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'confidence' in value &&
    'source' in value &&
    'evidence' in value
  );
}
