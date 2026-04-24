import { isValidLaborForm } from '../facts/labor-form';
import type { EntityExtractionResult } from '../types/session-facts.types';

/**
 * 把结构化提取结果渲染成统一字段列表。
 *
 * 供 session facts 渲染和 turn hints 渲染共用，避免重复维护字段顺序/文案。
 */
export function formatExtractionFactLines(facts: EntityExtractionResult): string[] {
  const { interview_info: info, preferences: pref } = facts;
  const lines: string[] = [];

  if (info.name) lines.push(`- 姓名: ${info.name}`);
  if (info.phone) lines.push(`- 联系方式: ${info.phone}`);
  if (info.gender) lines.push(`- 性别: ${info.gender}`);
  if (info.age) lines.push(`- 年龄: ${info.age}`);
  if (info.applied_store) lines.push(`- 应聘门店: ${info.applied_store}`);
  if (info.applied_position) lines.push(`- 应聘岗位: ${info.applied_position}`);
  if (info.interview_time) lines.push(`- 面试时间: ${info.interview_time}`);
  if (info.is_student != null) lines.push(`- 是否学生: ${info.is_student ? '是' : '否'}`);
  if (info.education) lines.push(`- 学历: ${info.education}`);
  if (info.has_health_certificate) lines.push(`- 健康证: ${info.has_health_certificate}`);

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
