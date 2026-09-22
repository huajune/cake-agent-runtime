import { addLocalDays, formatLocalDate, getLocalDayStart } from '@infra/utils/date.util';
import { CN_WORK_CALENDAR_2026, type WorkCalendar } from './cn-holidays-2026';
import { CATEGORY_META, type InterventionTaskCategory } from './intervention-task-category';

/**
 * 最晚跟进时间算法（PRD R6）。时限一律按运营上班时间计：工作日 9:30–18:30，
 * 下班不计时，周末与法定节假日顺到下一个工作日；调休上班的周末算工作日。
 * 全部按 Asia/Shanghai 计算，与容器时区无关。
 */

const MINUTE_MS = 60 * 1000;
export const WORKDAY_START_MINUTES = 9 * 60 + 30;
export const WORKDAY_END_MINUTES = 18 * 60 + 30;
const SAME_DAY_CUTOFF_MINUTES = 16 * 60 + 30;
const NEXT_DAY_NOON_MINUTES = 12 * 60;
const MIN_LEAD_MINUTES = 15;
const INTERVIEW_CAP_LEAD_MINUTES = 60;
const INTERVIEW_CAP_MIN_GAP_MINUTES = 30;
/** 防御：日历缺失（如 2027 年未维护）时最多向后找 60 天工作日。 */
const MAX_WORKDAY_SCAN = 60;

export interface FollowUpDueInput {
  category: InterventionTaskCategory;
  triggeredAt: Date;
  /** 面试时间（无则 null）；只对 interviewCapApplies 的大类生效。 */
  interviewAt?: Date | null;
  calendar?: WorkCalendar;
}

export interface FollowUpDueResult {
  /** 起算点：上班时间内触发即触发时刻，否则下一个上班时段 9:30。 */
  startAt: Date;
  dueAt: Date;
  /** 起算点被顺延（下班/周末/节假日触发）。 */
  offHoursTrigger: boolean;
  /** 面试早于起算点（下班期间触发且面试已临近/已过）：到期取起算点、优先级提到急、标题加说明。 */
  interviewImminent: boolean;
}

export function isWorkday(date: Date, calendar: WorkCalendar = CN_WORK_CALENDAR_2026): boolean {
  const key = formatLocalDate(date);
  if (calendar.holidays.has(key)) return false;
  if (calendar.makeupWorkdays.has(key)) return true;
  const weekday = localWeekday(date);
  return weekday >= 1 && weekday <= 5;
}

export function computeFollowUpDue(input: FollowUpDueInput): FollowUpDueResult {
  const calendar = input.calendar ?? CN_WORK_CALENDAR_2026;
  const meta = CATEGORY_META[input.category];
  const triggeredAt = truncateToMinute(input.triggeredAt);
  const startAt = resolveStartPoint(triggeredAt, calendar);
  const offHoursTrigger = startAt.getTime() !== triggeredAt.getTime();

  let dueAt =
    meta.deadline.kind === 'working_minutes'
      ? addWorkingMinutes(startAt, meta.deadline.minutes, calendar)
      : resolveSameDayOrNextNoon(startAt, calendar);

  let interviewImminent = false;
  const interviewAt = input.interviewAt ?? null;
  if (meta.interviewCapApplies && interviewAt) {
    if (interviewAt.getTime() <= startAt.getTime()) {
      interviewImminent = true;
      dueAt = startAt;
    } else {
      const cap = new Date(interviewAt.getTime() - INTERVIEW_CAP_LEAD_MINUTES * MINUTE_MS);
      const minGap = new Date(startAt.getTime() + INTERVIEW_CAP_MIN_GAP_MINUTES * MINUTE_MS);
      if (isWithinWorkHours(cap, calendar) && cap.getTime() > minGap.getTime()) {
        dueAt = cap.getTime() < dueAt.getTime() ? cap : dueAt;
      }
    }
  }

  // 最终值不早于起算点 + 15 分钟；仍按上班分钟数推进，避免 18:20 起算落到 18:35。
  const floor = addWorkingMinutes(startAt, MIN_LEAD_MINUTES, calendar);
  if (dueAt.getTime() < floor.getTime()) dueAt = floor;

  return { startAt, dueAt, offHoursTrigger, interviewImminent };
}

// ==================== 内部 ====================

function truncateToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** Asia/Shanghai 当天已过分钟数。 */
function localMinutesOfDay(date: Date): number {
  return Math.floor((date.getTime() - getLocalDayStart(date).getTime()) / MINUTE_MS);
}

/** 0=周日 … 6=周六（Asia/Shanghai）。 */
function localWeekday(date: Date): number {
  const dayStart = getLocalDayStart(date);
  // 日开始点 + 12h 落在同一天正中，取其 UTC 星期即本地星期（上海无夏令时）。
  return new Date(dayStart.getTime() + 12 * 60 * MINUTE_MS + 8 * 60 * MINUTE_MS).getUTCDay();
}

function atLocalMinutes(dayStart: Date, minutes: number): Date {
  return new Date(dayStart.getTime() + minutes * MINUTE_MS);
}

function isWithinWorkHours(date: Date, calendar: WorkCalendar): boolean {
  if (!isWorkday(date, calendar)) return false;
  const minutes = localMinutesOfDay(date);
  return minutes >= WORKDAY_START_MINUTES && minutes <= WORKDAY_END_MINUTES;
}

function nextWorkdayStart(fromDayStart: Date, calendar: WorkCalendar): Date {
  let day = addLocalDays(fromDayStart, 1);
  for (let i = 0; i < MAX_WORKDAY_SCAN; i += 1) {
    if (isWorkday(day, calendar))
      return atLocalMinutes(getLocalDayStart(day), WORKDAY_START_MINUTES);
    day = addLocalDays(day, 1);
  }
  return atLocalMinutes(getLocalDayStart(day), WORKDAY_START_MINUTES);
}

function resolveStartPoint(triggeredAt: Date, calendar: WorkCalendar): Date {
  const dayStart = getLocalDayStart(triggeredAt);
  if (isWorkday(triggeredAt, calendar)) {
    const minutes = localMinutesOfDay(triggeredAt);
    if (minutes < WORKDAY_START_MINUTES) return atLocalMinutes(dayStart, WORKDAY_START_MINUTES);
    if (minutes < WORKDAY_END_MINUTES) return triggeredAt;
  }
  return nextWorkdayStart(dayStart, calendar);
}

/** 从上班时间内的某点起，只数上班分钟往后推 minutes。 */
export function addWorkingMinutes(start: Date, minutes: number, calendar: WorkCalendar): Date {
  let cursor = start;
  let remaining = minutes;
  for (let i = 0; i < MAX_WORKDAY_SCAN; i += 1) {
    const available = WORKDAY_END_MINUTES - localMinutesOfDay(cursor);
    if (remaining <= available) return new Date(cursor.getTime() + remaining * MINUTE_MS);
    remaining -= available;
    cursor = nextWorkdayStart(getLocalDayStart(cursor), calendar);
  }
  return cursor;
}

/** T3/T8：起算点早于 16:30 取当天 18:30，否则次日 12:00。 */
function resolveSameDayOrNextNoon(startAt: Date, calendar: WorkCalendar): Date {
  const dayStart = getLocalDayStart(startAt);
  if (localMinutesOfDay(startAt) < SAME_DAY_CUTOFF_MINUTES) {
    return atLocalMinutes(dayStart, WORKDAY_END_MINUTES);
  }
  const nextStart = nextWorkdayStart(dayStart, calendar);
  return atLocalMinutes(getLocalDayStart(nextStart), NEXT_DAY_NOON_MINUTES);
}
