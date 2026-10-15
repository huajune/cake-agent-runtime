import type { JobSchedule, ShiftSlot, ShiftTag, TimeRange } from '@resolution/schedule/types';
import { SHIFT_TAG_LABELS } from '@resolution/schedule/types';
import { fixedSlotsRelation, type FixedSlotsRelation } from '@resolution/schedule/slots';
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

/** 超过 12 小时的班次按 6-8 小时兜底的时长说法，如“6-8 小时”。 */
function arrangedRangeText({ minMinutes, maxMinutes }: { minMinutes: number; maxMinutes: number }) {
  return `${minMinutes / 60}-${maxMinutes / 60} 小时`;
}

function tagText(tags: readonly ShiftTag[]): string {
  return tags.map((tag) => SHIFT_TAG_LABELS[tag]).join('、');
}

const FIXED_RELATION_TEXT: Record<FixedSlotsRelation, string> = {
  single: '需接受全部班次',
  separate_days: '各班次不在同一天上，需全部都能接受',
  unclear: '需接受全部班次，是否同一天连着上未明确',
};

/**
 * 文案只投影结构化事实，不根据时长或数组长度改写海绵的排班类型。
 * 灵活排班由门店按候选人可上班时间在区间内安排一个完整班次，不把区间跨度表述为工作时长。
 */
export function formatSchedule(schedule: JobSchedule | null): string | null {
  if (!schedule) return null;
  if (schedule.arrangementType === '灵活排班') {
    const tags = tagText(schedule.tags);
    return `灵活排班：排班区间 ${rangeText(schedule.window)}${tags ? `（可排${tags}）` : ''}，门店按候选人可上班时间在区间内安排每班 ${durationText(schedule.minimumMinutes)}，需完整上完一班`;
  }
  const slots = schedule.slots.map((slot) => {
    // 超过 12 小时的班次按灵活排班兜底：写时段内排班 6-8 小时，不写班次跨度，也不把话说死。
    const notes = slot.arranged
      ? [
          `时段内排班 ${arrangedRangeText(slot.arranged)}，实际可面试时和店长沟通`,
          tagText(slot.tags) && `可排${tagText(slot.tags)}`,
        ]
      : [tagText(slot.tags), `班次跨度 ${durationText(slot.endMinute - slot.startMinute)}`];
    return `${rangeText(slot)}（${notes.filter(Boolean).join('，')}）`;
  });
  // 超过 12 小时的时段按 6-8 小时排班，表头不写“完整接受该时段”。
  const hasLongSlot = schedule.slots.some((slot) => slot.arranged);
  const relation =
    schedule.arrangementType === '固定排班'
      ? schedule.slots.length === 1 && hasLongSlot
        ? '在以下时段内排班'
        : FIXED_RELATION_TEXT[fixedSlotsRelation(schedule.slots)]
      : schedule.slots.length === 1
        ? hasLongSlot
          ? '目前仅一档，在该时段内排班'
          : '目前仅一档，需完整接受该班次'
        : hasLongSlot
          ? '任选其中一档'
          : '任选其中一档完整班次';
  return `${schedule.arrangementType}（${relation}）：${slots.join(' / ')}`;
}

export function formatJobShiftTime(job: JobScheduleInput): string | null {
  return formatSchedule(getJobSchedule(job));
}

export function composeShiftTimeText(workTime: unknown): string | null {
  return workTime == null ? null : formatSchedule(normalizeJobSchedule(workTime));
}

// ==================== 候选人卡片的简短班次 ====================

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 跨天结束写“次日2:00”，刚好 24 点写“24:00”。 */
function shortRangeText({ startMinute, endMinute }: TimeRange): string {
  const end =
    endMinute === 1440
      ? '24:00'
      : endMinute > 1440
        ? `次日${Math.floor((endMinute - 1440) / 60)}:${String((endMinute - 1440) % 60).padStart(2, '0')}`
        : minutesToClock(endMinute);
  return `${minutesToClock(startMinute)}-${end}`;
}

function shortDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours}小时` : `${hours}小时${rest}分钟`;
}

function longSlotText(slot: ShiftSlot): string {
  return `${shortRangeText(slot)} 间排 ${slot.arranged ? arrangedRangeText(slot.arranged) : ''}`;
}

/**
 * 候选人卡片上的班次：只写几点上班、上几个小时、怎么选，不出现排班类型名、班次标签和班次跨度；
 * 这些仍由 formatSchedule 写进给 Agent 的岗位详情。超过 12 小时的班次按 6-8 小时兜底，
 * 提示面试时可和店长沟通；“是否同一天连着上未明确”的固定排班卡片上不提，追问时按手册转人工。
 */
export function formatScheduleForCandidate(schedule: JobSchedule | null): string | null {
  if (!schedule) return null;
  if (schedule.arrangementType === '灵活排班') {
    const { window, minimumMinutes } = schedule;
    const where =
      window.endMinute - window.startMinute >= 1440
        ? '24 小时店，按你的时间排'
        : `${shortRangeText(window)} 间按你的时间排`;
    return `${where}，每次 ${shortDuration(minimumMinutes).replace('小时', ' 小时')}`;
  }
  const { slots } = schedule;
  const hasLong = slots.some((slot) => slot.arranged);
  const slotText = (slot: ShiftSlot) => (slot.arranged ? longSlotText(slot) : shortRangeText(slot));
  if (slots.length === 1) {
    const [slot] = slots;
    return slot.arranged
      ? `${longSlotText(slot)}，面试时可和店长沟通`
      : `${shortRangeText(slot)}（${shortDuration(slot.endMinute - slot.startMinute)}）`;
  }
  if (schedule.arrangementType === '组合排班制') {
    const choice = `${CN_DIGITS[slots.length] ?? slots.length}选一`;
    return hasLong
      ? `${slots.map(slotText).join('，或 ')}，${choice}`
      : `${slots.map(slotText).join(' / ')} ${choice}`;
  }
  if (fixedSlotsRelation(slots) === 'separate_days')
    return `${slots.map(slotText).join(' / ')} 轮班，都要能上`;
  const texts = slots.map(slotText);
  const listed =
    texts.length === 2
      ? `${texts[0]} 和 ${texts[1]}，两个都要能上`
      : `${texts.slice(0, -1).join('、')} 和 ${texts[texts.length - 1]}，都要能上`;
  return listed;
}

export function formatJobShiftTimeForCandidate(job: JobScheduleInput): string | null {
  return formatScheduleForCandidate(getJobSchedule(job));
}
