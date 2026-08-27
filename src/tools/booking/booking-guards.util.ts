/** Booking guards that remain outside the live collection-form contract. */
import type { JobDetail } from '@sponge/sponge.types';
import { isStrictRealChineseName } from '@resolution/candidate/name';
import { buildJobPolicyAnalysis, InterviewWindow } from '@tools/job-list/job-policy-parser';
import {
  compareTime,
  findSameDayCutoffViolation,
  getShanghaiWeekday,
  isDateOnlyWindow,
  normalizeHm,
  resolveBookingDeadlineDateTime,
} from '@tools/booking/interview-window.util';
import {
  buildToolError,
  TOOL_ERROR_TYPES,
  type ToolErrorReturn,
} from '@tools/shared/tool-error-types';

/**
 * 标签契约接管后的 booking 兜底：只保留不属于收资判决的两项服务端守卫。
 * 筛选字段已经由实时 label contract 判决，禁止再读岗位自由文本开第二套筛选源。
 */
export function runBookingScheduleAndNameGuards(input: {
  job: JobDetail;
  name: string;
  interviewTime?: string;
}): ToolErrorReturn | null {
  return (
    checkRealName(input.name) ??
    validateInterviewTimeAgainstSchedule(input.interviewTime, input.job)
  );
}

function checkRealName(name: string): ToolErrorReturn | null {
  if (isStrictRealChineseName(name)) return null;
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
    outcome: '预约失败（姓名可疑，疑似昵称/占位串）',
    replyInstruction:
      'booking 入参 name 看起来不像真实姓名（昵称/拼音/占位串等）。回到 duliday_interview_precheck 重新核对——若 nameFieldGuard.suspicious=true 则向候选人补问真名（"门店登记需要本名"）；若 nameFieldGuard.mustHandoff=true 则调 request_handoff(reasonCode="other", reason="疑似少数民族/特殊姓名 booking 校验拒绝") 转人工。严禁在没有合规真名的情况下重试本工具。',
    details: { detailedReason: `name="${name}" 未通过 isStrictRealChineseName 校验（2-4 字）` },
  });
}

function validateInterviewTimeAgainstSchedule(
  interviewTime: string | undefined,
  job: JobDetail,
): ToolErrorReturn | null {
  const analysis = buildJobPolicyAnalysis(job);
  const windows = analysis.interviewWindows;
  // 该岗位没配面试窗口（等通知岗位）——无校验源，跳过
  if (windows.length === 0) return null;
  // interviewTime 缺省：booking 入口已对有窗口岗位强制必填，这里只是类型防御
  if (!interviewTime) return null;

  const [date, hms] = interviewTime.split(' ');
  if (!date || !hms) return null;

  // 同日报名截止——badcase 簇 booking_same_day_cutoff
  const cutoffViolation = findSameDayCutoffViolation(date, windows);
  if (cutoffViolation) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME,
      outcome: '预约失败（已过当日报名截止）',
      replyInstruction:
        '今天的报名时间已经截止。用招募者口吻告诉候选人"今天的报名时间已经截止，咱们看下明天/后天哪个时间方便，我帮你重新约"，并主动给出未来 1-2 天的可约日期；严禁再以今日为面试日期提交。先调 duliday_interview_precheck 拿到合法的次日 slot 再重试 booking。',
      details: {
        detailedReason: cutoffViolation.reason,
        registrationDeadline: cutoffViolation.latestDeadline,
      },
    });
  }

  // 日期完全不在窗口里——LLM 可能从历史抓了一个旧日期或者凭印象造日期
  const matchedWindows = matchWindowsForDate(windows, date);
  if (matchedWindows.length === 0) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME,
      outcome: '预约失败（该日无可用面试时段）',
      replyInstruction:
        '当前 interviewTime 的日期没有匹配的面试窗口。先调 duliday_interview_precheck 拿当前岗位的 bookableSlots，只有 bookingAllowed=true 且带 interviewTime 的 slot 才能用于 booking；不要凭历史对话或印象拼日期。',
      details: {
        detailedReason: `${date} 没有可预约的面试时段`,
        availableSlots: windows.slice(0, 8).map((window) => ({
          date: window.date ?? null,
          weekday: window.weekday ?? null,
          startTime: window.startTime,
          endTime: window.endTime,
          deadline: resolveBookingDeadlineDateTime(date, window),
        })),
      },
    });
  }

  // 时分必须落在匹配窗口的 [startTime, endTime] 内。窗口制岗位允许提交候选人在
  // 窗口内约定的具体时刻（badcase chat 6a5f3080：候选人约 15:00、工单却落窗口起点
  // 10:00，下游按工单时间等人），但窗口外的时刻仍是臆造，照拦。
  // dateOnly / 起止时间不可解析的窗口没有时分校验源，跳过（这类 slot 由
  // bookingAllowed=false 在 prompt 层禁止自动提交）。
  const hm = normalizeHm(hms);
  if (hm) {
    const timeWithinSomeWindow = matchedWindows.some((window) => {
      if (isDateOnlyWindow(window)) return true;
      const start = normalizeHm(window.startTime);
      const end = normalizeHm(window.endTime);
      if (!start || !end) return true;
      return compareTime(hm, start) >= 0 && compareTime(hm, end) <= 0;
    });
    if (!timeWithinSomeWindow) {
      return buildToolError({
        errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME,
        outcome: '预约失败（时刻不在面试窗口内）',
        replyInstruction:
          '当前 interviewTime 的时刻不在该日面试窗口内。窗口制岗位只能提交窗口起止时间之间的时刻：' +
          '候选人明确约定了窗口内某时刻就用该时刻，否则用 bookableSlots 里 slot 自带的 interviewTime（窗口起点）；不要凭印象拼时间。',
        details: {
          detailedReason: `${hm} 不在 ${date} 的面试窗口内`,
          availableSlots: matchedWindows.slice(0, 8).map((window) => ({
            date: window.date ?? null,
            weekday: window.weekday ?? null,
            startTime: window.startTime,
            endTime: window.endTime,
          })),
        },
      });
    }
  }

  return null;
}

function matchWindowsForDate(windows: InterviewWindow[], date: string): InterviewWindow[] {
  const weekday = getShanghaiWeekday(date);
  return windows.filter((window) => {
    if (window.date) return window.date === date;
    if (window.weekday) return window.weekday === weekday;
    return false;
  });
}
