import { isValidLaborForm } from '../facts/labor-form';
import type {
  EntityExtractionResult,
  HighConfidenceFacts,
  HighConfidenceValue,
} from '../types/session-facts.types';

/**
 * 把结构化提取结果渲染成统一字段列表。
 *
 * 供 session facts 渲染和 turn hints 渲染共用，避免重复维护字段顺序/文案。
 */
export function formatExtractionFactLines(
  facts: EntityExtractionResult | HighConfidenceFacts,
): string[] {
  const { interview_info: info, preferences: pref } = facts;
  const lines: string[] = [];

  const name = readFactValue(info.name);
  if (name) lines.push(`- 姓名: ${name}${formatInlineFactMeta(info.name)}`);

  const phone = readFactValue(info.phone);
  if (phone) lines.push(`- 联系方式: ${phone}${formatInlineFactMeta(info.phone)}`);

  const gender = readFactValue(info.gender);
  if (gender) {
    const sourceTag =
      info.gender_source === 'candidate'
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
  if (pref.labor_form && isValidLaborForm(pref.labor_form)) {
    lines.push(`- 用工形式: ${pref.labor_form}`);
  }
  if (pref.brands?.length) lines.push(`- 意向品牌: ${pref.brands.join('、')}`);
  if (pref.salary) lines.push(`- 意向薪资: ${pref.salary}`);
  if (pref.position?.length) lines.push(`- 意向岗位: ${pref.position.join('、')}`);
  if (pref.schedule) lines.push(`- 意向班次: ${pref.schedule}`);
  if (pref.city?.value) {
    lines.push(
      `- 意向城市: ${pref.city.value}（置信度: ${pref.city.confidence}，证据: ${pref.city.evidence}）`,
    );
  }
  if (pref.district?.length) lines.push(`- 意向区域: ${pref.district.join('、')}`);
  if (pref.location?.length) lines.push(`- 意向地点: ${pref.location.join('、')}`);

  return lines;
}

function readFactValue<T>(value: HighConfidenceValue<T> | T | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  return isInlineHighConfidenceValue(value) ? value.value : value;
}

function formatInlineFactMeta(value: unknown): string {
  if (!isInlineHighConfidenceValue(value)) return '';
  const parts = [`置信度: ${value.confidence}`, `来源: ${value.source}`, `证据: ${value.evidence}`];
  return `（${parts.join('，')}）`;
}

function isInlineHighConfidenceValue(value: unknown): value is HighConfidenceValue<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'confidence' in value &&
    'evidence' in value
  );
}
