import type { JobSchedule, TimeRange } from '@resolution/schedule/types';
import { SHIFT_TAG_LABELS } from '@resolution/schedule/types';
import { minutesToClock } from '@resolution/schedule/time';
import {
  getJobSchedule,
  normalizeJobSchedule,
  type JobScheduleInput,
} from './schedule-normalizer.util';

function rangeText(range: TimeRange): string {
  return `${minutesToClock(range.startMinute)}-${range.endMinute >= 1440 ? '次日' : ''}${minutesToClock(range.endMinute)}`;
}

/** 文案只投影结构化事实，不根据时长或数组长度改写海绵的排班类型。 */
export function formatSchedule(schedule: JobSchedule | null): string | null {
  if (!schedule) return null;
  if (schedule.arrangementType === '灵活排班') {
    return `灵活排班：排班窗口 ${rangeText(schedule.window)}，每日最少 ${schedule.minimumMinutes / 60} 小时；实际可安排班次待确认`;
  }
  const slots = schedule.slots.map(
    (slot) =>
      `${rangeText(slot)}（${slot.tags.map((tag) => SHIFT_TAG_LABELS[tag]).join('、')}，班次跨度 ${(slot.endMinute - slot.startMinute) / 60} 小时）`,
  );
  const relation =
    schedule.arrangementType === '固定排班' ? '需接受全部班次' : '任选其中一档完整班次';
  return `${schedule.arrangementType}（${relation}）：${slots.join(' / ')}`;
}

export function formatJobShiftTime(job: JobScheduleInput): string | null {
  return formatSchedule(getJobSchedule(job));
}

export function composeShiftTimeText(workTime: unknown): string | null {
  return workTime == null ? null : formatSchedule(normalizeJobSchedule(workTime));
}
