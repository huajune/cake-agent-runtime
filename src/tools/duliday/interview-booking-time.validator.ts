import type { JobDetail } from '@sponge/sponge.types';
import { buildJobPolicyAnalysis, type InterviewWindow } from '@tools/duliday/job-policy-parser';
import {
  compareTime,
  findSameDayCutoffViolation,
  getShanghaiWeekday,
  isDateOnlyWindow,
  normalizeHm,
  resolveBookingDeadlineDateTime,
} from '@tools/duliday/interview-window.util';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

function matchWindowsForDate(windows: InterviewWindow[], date: string): InterviewWindow[] {
  const weekday = getShanghaiWeekday(date);
  return windows.filter((window) => {
    if (window.date) return window.date === date;
    if (window.weekday) return window.weekday === weekday;
    return false;
  });
}

function formatWindowLabel(date: string, window: InterviewWindow): string {
  const deadline = resolveBookingDeadlineDateTime(date, window);
  const deadlineText = deadline ? `（报名截止 ${deadline}）` : '';
  return `${date} ${window.startTime}-${window.endTime}${deadlineText}`;
}

export function validateInterviewTimeAgainstSchedule(
  interviewTime: string,
  job: JobDetail,
): Record<string, unknown> | null {
  const analysis = buildJobPolicyAnalysis(job);
  const windows = analysis.interviewWindows;
  if (windows.length === 0) return null;

  const [date, hms] = interviewTime.split(' ');
  const hm = hms?.slice(0, 5);
  if (!date || !hm) return null;

  // 同日报名截止硬阻断（badcase 簇 booking_same_day_cutoff，5 条）：
  // 模型可以跳过 precheck 直接调 booking；这里在工具入口再校验一次。
  const cutoffViolation = findSameDayCutoffViolation(date, windows);
  if (cutoffViolation) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_PAST_SAME_DAY_CUTOFF,
      outcome: '预约失败（已过当日报名截止）',
      replyInstruction:
        '不要直接说"过截止时间"或暴露后台规则。用招募者口吻告诉候选人"今天的报名时间已经截止，咱们看下明天/后天哪个时间方便，我帮你重新约"，并主动给出未来 1-2 天的可约日期。严禁再尝试用今天的日期重新提交。',
      details: {
        registrationDeadline: cutoffViolation.latestDeadline,
        detailedReason: cutoffViolation.reason,
      },
    });
  }

  const matchedWindows = matchWindowsForDate(windows, date);
  if (matchedWindows.length === 0) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME_SLOT,
      outcome: '预约失败（该日期无可预约时段）',
      replyInstruction:
        '该日期没有可预约时段。不要透露接口细节；基于 availableSlots 给候选人 1-2 个可选时段建议，' +
        '或调用 duliday_interview_precheck 重新拉取可约 slot。',
      details: {
        detailedReason: `${date} 没有可预约的面试时段`,
        availableSlots: windows.slice(0, 8).map((window) => ({
          date: window.date,
          weekday: window.weekday,
          startTime: window.startTime,
          endTime: window.endTime,
        })),
      },
    });
  }

  const concreteWindows = matchedWindows.filter((window) => !isDateOnlyWindow(window));
  const validConcreteWindow = concreteWindows.find((window) => {
    const startHm = normalizeHm(window.startTime);
    const endHm = normalizeHm(window.endTime) ?? startHm;
    if (!startHm || !endHm) return false;
    return compareTime(hm, startHm) >= 0 && compareTime(hm, endHm) <= 0;
  });
  if (validConcreteWindow) return null;

  const submittedDateTime = `${date} ${hm}`;
  const matchedDeadline = matchedWindows
    .map((window) => resolveBookingDeadlineDateTime(date, window))
    .find((deadline): deadline is string => Boolean(deadline && deadline === submittedDateTime));

  if (matchedDeadline) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_DEADLINE_USED_AS_INTERVIEW_TIME,
      outcome: '预约失败（误把报名截止时间当面试时间）',
      replyInstruction:
        '预约未提交。请以真人招募者口吻告诉候选人"这个日期可以，但具体面试时间我让同事确认一下"，不要说已经约好，不要透露接口或系统细节。',
      details: {
        registrationDeadline: matchedDeadline,
        detailedReason: `${matchedDeadline} 是报名截止时间，不是面试时间；严禁把报名截止时间作为 interviewTime 提交。`,
      },
    });
  }

  if (concreteWindows.length === 0 && matchedWindows.some(isDateOnlyWindow)) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_AMBIGUOUS_DATE_ONLY_SLOT,
      outcome: '预约失败（窗口只确定日期未确定时间）',
      replyInstruction:
        '预约未提交。请以真人招募者口吻告诉候选人"这个日期可以，线上面试具体时间我让同事确认一下"，不要说已经约好，不要透露接口或系统细节。',
      details: {
        date,
        matchedSlots: matchedWindows.map((window) => formatWindowLabel(date, window)),
        detailedReason:
          '该面试窗口只标注 00:00-00:00，表示只确定日期、不确定具体几点；在未确认上游提交契约前，不自动预约。',
      },
    });
  }

  return buildToolError({
    errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME_SLOT,
    outcome: '预约失败（提交时间不在可预约时段）',
    replyInstruction:
      '提交时间不在该岗位可预约时段。基于 availableSlots 给候选人重新挑选时间，' +
      '禁止说"已为您约好"或透露接口细节。',
    details: {
      detailedReason: `${interviewTime} 不在该岗位可预约的面试时段内`,
      availableSlots: matchedWindows.map((window) => formatWindowLabel(date, window)),
    },
  });
}
