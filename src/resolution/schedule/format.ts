import {
  SHIFT_TAG_LABELS,
  StoredScheduleConstraintSchema,
  readScheduleConditions,
  hasScheduleConstraint,
  type CandidateScheduleConstraint,
} from './types';

export function formatScheduleConstraintLabel(c: CandidateScheduleConstraint): string {
  const parts: string[] = [];
  if (c.onlyWeekends) parts.push('只周末');
  if (c.includeAnyTags?.length)
    parts.push(`要求 ${c.includeAnyTags.map((t) => SHIFT_TAG_LABELS[t]).join('或')}`);
  if (c.excludeTags?.length)
    parts.push(`排除 ${c.excludeTags.map((t) => SHIFT_TAG_LABELS[t]).join('、')}`);
  if (typeof c.maxDaysPerWeek === 'number') parts.push(`每周最多 ${c.maxDaysPerWeek} 天`);
  if (c.availableWindow)
    parts.push(
      `可上班时段 ${c.availableWindow.start ?? '不限'}-${c.availableWindow.endDayOffset ? '次日' : ''}${c.availableWindow.end ?? '不限'}`,
    );
  if (c.unavailableWindow)
    parts.push(
      `不可上班 ${c.unavailableWindow.start ?? '不限'}-${c.unavailableWindow.endDayOffset ? '次日' : ''}${c.unavailableWindow.end ?? '不限'}`,
    );
  if (c.minShiftHours != null) parts.push(`每班至少 ${c.minShiftHours} 小时`);
  if (c.maxShiftHours != null) parts.push(`每班至多 ${c.maxShiftHours} 小时`);
  return parts.join(' / ') || '未明确';
}

/** Memory 与主生成/修复共用字段投影，避免新字段写入后对模型不可见。 */
export function formatStoredScheduleConstraint(value: unknown): string | null {
  if (value == null) return null;
  const parsed = StoredScheduleConstraintSchema.safeParse(value);
  if (!parsed.success) return '已有排班条件需重新确认';
  const { conditions, legacyUnresolved } = readScheduleConditions(parsed.data);
  const parts = hasScheduleConstraint(conditions)
    ? [formatScheduleConstraintLabel(conditions)]
    : [];
  if (legacyUnresolved) parts.push('历史早晚班偏好含义需确认');
  return parts.length ? parts.join(' / ') : null;
}
