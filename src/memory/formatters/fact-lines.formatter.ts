import { isValidLaborForm } from '../facts/labor-form';
import type {
  EntityExtractionResult,
  HighConfidenceFacts,
  HighConfidenceValue,
  SessionFacts,
  SessionFactValue,
} from '../types/session-facts.types';

/**
 * 把结构化提取结果渲染成统一字段列表。
 *
 * 供 session facts 渲染和 turn hints 渲染共用，避免重复维护字段顺序/文案。
 */
export function formatExtractionFactLines(
  facts: EntityExtractionResult | HighConfidenceFacts | SessionFacts,
): string[] {
  const { interview_info: info, preferences: pref } = facts;
  const lines: string[] = [];

  const name = readFactValue(info.name);
  if (name) lines.push(`- 姓名: ${name}${formatInlineFactMeta(info.name)}`);

  const phone = readFactValue(info.phone);
  if (phone) lines.push(`- 联系方式: ${phone}${formatInlineFactMeta(info.phone)}`);

  const gender = readFactValue(info.gender);
  if (gender) {
    const genderSource = readFactValue(info.gender_source);
    const sourceTag =
      genderSource === 'candidate'
        ? '（候选人自陈）'
        : '（系统标签，未经候选人自陈，不得用于直接排除候选人）';
    lines.push(`- 性别: ${gender}${sourceTag}${formatInlineFactMeta(info.gender)}`);
  }

  const age = readFactValue(info.age);
  if (age) lines.push(`- 年龄: ${age}${formatInlineFactMeta(info.age)}`);

  const appliedStore = readFactValue(info.applied_store);
  if (appliedStore)
    lines.push(`- 应聘门店: ${appliedStore}${formatInlineFactMeta(info.applied_store)}`);

  const appliedPosition = readFactValue(info.applied_position);
  if (appliedPosition)
    lines.push(`- 应聘岗位: ${appliedPosition}${formatInlineFactMeta(info.applied_position)}`);

  const interviewTime = readFactValue(info.interview_time);
  if (interviewTime)
    lines.push(`- 面试时间: ${interviewTime}${formatInlineFactMeta(info.interview_time)}`);

  const isStudent = readFactValue(info.is_student);
  if (isStudent != null)
    lines.push(`- 是否学生: ${isStudent ? '是' : '否'}${formatInlineFactMeta(info.is_student)}`);

  const education = readFactValue(info.education);
  if (education) lines.push(`- 学历: ${education}${formatInlineFactMeta(info.education)}`);

  const healthCertificate = readFactValue(info.has_health_certificate);
  if (healthCertificate)
    lines.push(
      `- 健康证: ${healthCertificate}${formatInlineFactMeta(info.has_health_certificate)}`,
    );

  // 历史数据里可能存在 labor_form="兼职"/"全职"，读取时过滤掉（平台全为兼职，这类值无筛选价值）。
  const laborForm = readFactValue(pref.labor_form);
  if (laborForm && isValidLaborForm(laborForm)) {
    lines.push(`- 用工形式: ${laborForm}${formatInlineFactMeta(pref.labor_form)}`);
  }
  const brands = readFactValue(pref.brands);
  if (brands?.length)
    lines.push(`- 意向品牌: ${brands.join('、')}${formatInlineFactMeta(pref.brands)}`);
  const salary = readFactValue(pref.salary);
  if (salary) lines.push(`- 意向薪资: ${salary}${formatInlineFactMeta(pref.salary)}`);
  const position = readFactValue(pref.position);
  if (position?.length)
    lines.push(`- 意向岗位: ${position.join('、')}${formatInlineFactMeta(pref.position)}`);
  const schedule = readFactValue(pref.schedule);
  if (schedule) lines.push(`- 意向班次: ${schedule}${formatInlineFactMeta(pref.schedule)}`);
  const city = pref.city;
  if (isInlineHighConfidenceValue(city)) {
    lines.push(`- 意向城市: ${city.value}${formatInlineFactMeta(city)}`);
  } else if (city?.value) {
    lines.push(`- 意向城市: ${city.value}（置信度: ${city.confidence}，证据: ${city.evidence}）`);
  }
  const district = readFactValue(pref.district);
  if (district?.length)
    lines.push(`- 意向区域: ${district.join('、')}${formatInlineFactMeta(pref.district)}`);
  const location = readFactValue(pref.location);
  if (location?.length)
    lines.push(`- 意向地点: ${location.join('、')}${formatInlineFactMeta(pref.location)}`);
  const delayedIntent = readFactValue(pref.delayed_intent);
  if (delayedIntent)
    lines.push(
      `- 推迟意向: ${delayedIntent.until}（原话: ${delayedIntent.raw}）${formatInlineFactMeta(pref.delayed_intent)}`,
    );
  const shortTerm = readFactValue(pref.short_term);
  if (shortTerm != null)
    lines.push(`- 短期工意向: ${shortTerm ? '是' : '否'}${formatInlineFactMeta(pref.short_term)}`);
  const openPosition = readFactValue(pref.open_position);
  if (openPosition != null)
    lines.push(
      `- 岗位开放: ${openPosition ? '是' : '否'}${formatInlineFactMeta(pref.open_position)}`,
    );
  const timeWindows = readFactValue(pref.time_windows);
  if (timeWindows?.length)
    lines.push(
      `- 可用时间窗口: ${timeWindows.join('、')}${formatInlineFactMeta(pref.time_windows)}`,
    );
  const scheduleConstraint = readFactValue(pref.schedule_constraint);
  if (scheduleConstraint) {
    const parts: string[] = [];
    if (scheduleConstraint.onlyWeekends) parts.push('只周末');
    if (scheduleConstraint.onlyEvenings) parts.push('只晚班');
    if (scheduleConstraint.onlyMornings) parts.push('只早班');
    if (scheduleConstraint.maxDaysPerWeek)
      parts.push(`每周最多${scheduleConstraint.maxDaysPerWeek}天`);
    if (parts.length)
      lines.push(
        `- 结构化排班约束: ${parts.join('、')}${formatInlineFactMeta(pref.schedule_constraint)}`,
      );
  }
  const availableAfter = readFactValue(pref.available_after);
  if (availableAfter)
    lines.push(
      `- 最早可面试日期: ${availableAfter.date}（原话: ${availableAfter.raw}）${formatInlineFactMeta(pref.available_after)}`,
    );

  return lines;
}

function readFactValue<T>(
  value: HighConfidenceValue<T> | SessionFactValue<T> | T | null | undefined,
): T | null {
  if (value === null || value === undefined) return null;
  return isInlineHighConfidenceValue(value) ? value.value : value;
}

function formatInlineFactMeta(value: unknown): string {
  if (!isInlineHighConfidenceValue(value)) return '';
  const parts = [`置信度: ${value.confidence}`, `来源: ${value.source}`, `证据: ${value.evidence}`];
  return `（${parts.join('，')}）`;
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
