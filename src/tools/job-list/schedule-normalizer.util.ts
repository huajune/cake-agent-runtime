import { parseDayWorkTime } from '@sponge/work-time.types';
import { longSlotArrangement } from '@resolution/schedule/slots';
import { buildShiftTags } from '@resolution/schedule/tags';
import { clockToMinutes, MINUTES_PER_DAY } from '@resolution/schedule/time';
import { SHIFT_TAGS, type JobSchedule } from '@resolution/schedule/types';
export interface JobScheduleInput {
  workTime?: unknown;
  basicInfo?: { jobId?: unknown };
}

export function normalizeJobSchedule(workTime: unknown, jobId: number | null = null): JobSchedule {
  const day = parseDayWorkTime(workTime, jobId);
  if (day.arrangementType === '灵活排班') {
    const ft = day.fixedTime;
    const window = {
      startMinute: clockToMinutes(ft.goToWorkStartTime),
      endMinute:
        clockToMinutes(ft.goOffWorkEndTime) +
        (ft.goOffWorkTimeType === '次日' ? MINUTES_PER_DAY : 0),
    };
    return {
      arrangementType: day.arrangementType,
      window,
      // 每班时长取整到分钟（如 6.33 小时），避免示例时段出现小数分钟。
      minimumMinutes: Math.round(Number(ft.perDayMinWorkHours) * 60),
      tags: buildShiftTags(window),
    };
  }
  const slots = day.combinedArrangement.map((slot, index) => {
    const startMinute = clockToMinutes(slot.combinedArrangementStartTime);
    const endClock = clockToMinutes(slot.combinedArrangementEndTime);
    const range = {
      startMinute,
      endMinute: endClock + (endClock < startMinute ? MINUTES_PER_DAY : 0),
    };
    const arranged = longSlotArrangement(range);
    return { ...range, index, tags: buildShiftTags(range), ...(arranged ? { arranged } : {}) };
  });
  return {
    arrangementType: day.arrangementType,
    slots,
    tags: SHIFT_TAGS.filter((tag) => slots.some((slot) => slot.tags.includes(tag))),
  };
}

/** 生命周期与本次取回的岗位对象相同；筛选、卡片与摘要复用计算结果。 */
const schedules = new WeakMap<JobScheduleInput, JobSchedule>();
export function getJobSchedule(job: JobScheduleInput): JobSchedule | null {
  if (job.workTime === undefined || job.workTime === null) return null;
  let schedule = schedules.get(job);
  if (!schedule) {
    schedule = normalizeJobSchedule(
      job.workTime,
      typeof job.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null,
    );
    schedules.set(job, schedule);
  }
  return schedule;
}
