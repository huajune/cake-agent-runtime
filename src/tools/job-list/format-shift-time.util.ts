import type { JobSchedule, ShiftTag, TimeRange } from '@resolution/schedule/types';
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

/** 时长按整分钟展示为“X 小时 Y 分钟”，不输出浮点小数。 */
function durationText(minutes: number): string {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (rest === 0) return `${hours} 小时`;
  return hours > 0 ? `${hours} 小时 ${rest} 分钟` : `${rest} 分钟`;
}

function tagText(tags: readonly ShiftTag[]): string {
  return tags.map((tag) => SHIFT_TAG_LABELS[tag]).join('、');
}

/**
 * 文案只投影结构化事实，不根据时长或数组长度改写海绵的排班类型。
 * 灵活排班须整段接受排班区间，由门店在区间内安排每班时长，不能表述为区间内自选时段。
 */
export function formatSchedule(schedule: JobSchedule | null): string | null {
  if (!schedule) return null;
  if (schedule.arrangementType === '灵活排班') {
    const tags = tagText(schedule.tags);
    return `灵活排班：需接受整个排班区间 ${rangeText(schedule.window)}${tags ? `（${tags}）` : ''}，门店在区间内安排每班 ${durationText(schedule.minimumMinutes)}`;
  }
  const slots = schedule.slots.map((slot) => {
    const notes = [
      tagText(slot.tags),
      `班次跨度 ${durationText(slot.endMinute - slot.startMinute)}`,
    ].filter(Boolean);
    return `${rangeText(slot)}（${notes.join('，')}）`;
  });
  const relation =
    schedule.arrangementType === '固定排班'
      ? '需接受全部班次'
      : schedule.slots.length === 1
        ? '目前仅一档，需完整接受该班次'
        : '任选其中一档完整班次';
  return `${schedule.arrangementType}（${relation}）：${slots.join(' / ')}`;
}

export function formatJobShiftTime(job: JobScheduleInput): string | null {
  return formatSchedule(getJobSchedule(job));
}

export function composeShiftTimeText(workTime: unknown): string | null {
  return workTime == null ? null : formatSchedule(normalizeJobSchedule(workTime));
}
