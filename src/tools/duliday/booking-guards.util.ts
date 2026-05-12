/**
 * Booking-time defense-in-depth guards.
 *
 * 设计目的：duliday_interview_booking 工具描述上要求"先调 precheck 再调 booking"，
 * 但 LLM 偶发会跳过 precheck 直接调 booking、或无视 precheck 的 nameFieldGuard /
 * screeningChecks 警告硬塞数据。下列三类硬规则在 precheck 已经做过一次，
 * booking 在调 sponge API 之前再跑一次，作为 server-side 兜底：
 *
 * 1. 真实姓名 (isLikelyRealChineseName)
 *    — badcase 簇 booking_real_name_required (5 cases)
 * 2. 面试时段 (validateInterviewTimeAgainstSchedule)
 *    — badcase 簇 booking_same_day_cutoff (5 cases) + invalid_interview_time_slot
 * 3. 筛选答案 (findScreeningFailure)
 *    — badcase 69e9bba2 (agent 把不合格候选人直接送进 booking)
 *
 * 与 precheck 共用底层函数（name-guard / interview-window / supplement-label-classifier），
 * 不存在双口径漂移风险；多花的成本是 booking 路径上一次本地数据计算（不增加 sponge 调用）。
 */
import type { JobDetail } from '@sponge/sponge.types';
import { isLikelyRealChineseName } from '@memory/facts/name-guard';
import { buildJobPolicyAnalysis, InterviewWindow } from '@tools/duliday/job-policy-parser';
import {
  findSameDayCutoffViolation,
  getShanghaiWeekday,
  resolveBookingDeadlineDateTime,
} from '@tools/duliday/interview-window.util';
import {
  findScreeningFailure,
  type ScreeningFailure,
} from '@tools/duliday/supplement-label-classifier';
import {
  buildToolError,
  TOOL_ERROR_TYPES,
  type ToolErrorReturn,
} from '@tools/types/tool-error-types';

export interface BookingGuardInput {
  job: JobDetail;
  name: string;
  interviewTime: string;
  supplementAnswers?: Record<string, string>;
}

/**
 * 跑完三个 booking guard。命中即返回 ToolErrorReturn；全部通过返回 null。
 *
 * 调用方应在 booking 路径上拿到 job 数据后、调 sponge bookInterview API 之前调用本函数。
 */
export function runBookingGuards(input: BookingGuardInput): ToolErrorReturn | null {
  const nameFailure = checkRealName(input.name);
  if (nameFailure) return nameFailure;

  const timeFailure = validateInterviewTimeAgainstSchedule(input.interviewTime, input.job);
  if (timeFailure) return timeFailure;

  const screeningFailure = checkScreeningAnswers(input.supplementAnswers);
  if (screeningFailure) return screeningFailure;

  return null;
}

function checkRealName(name: string): ToolErrorReturn | null {
  if (isLikelyRealChineseName(name)) return null;
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
    outcome: '预约失败（姓名可疑，疑似昵称/占位串）',
    replyInstruction:
      'booking 入参 name 看起来不像真实姓名（昵称/拼音/占位串等）。回到 duliday_interview_precheck 重新核对——若 nameFieldGuard.suspicious=true 则向候选人补问真名（"门店登记需要本名"）；若 nameFieldGuard.mustHandoff=true 则调 request_handoff(reasonCode="other", reason="疑似少数民族/特殊姓名 booking 校验拒绝") 转人工。严禁在没有合规真名的情况下重试本工具。',
    details: { detailedReason: `name="${name}" 未通过 isLikelyRealChineseName 校验` },
  });
}

function checkScreeningAnswers(
  supplementAnswers: Record<string, string> | undefined,
): ToolErrorReturn | null {
  const failure: ScreeningFailure | null = findScreeningFailure(supplementAnswers);
  if (!failure) return null;
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
    outcome: '预约失败（筛选题命中不合格答案）',
    replyInstruction:
      '候选人的筛选答案已经命中岗位的 failSignal。先调 duliday_interview_precheck 复核 screeningChecks；命中不合格答案的应走 invite_to_group（候选人加群继续匹配其它岗位）或 request_handoff 转人工，严禁带着不合格答案重试 booking。',
    details: {
      detailedReason: `筛选题 "${failure.label}" 答 "${failure.answer}" 命中失败信号 "${failure.matched}"`,
      screeningFailure: failure,
    },
  });
}

function validateInterviewTimeAgainstSchedule(
  interviewTime: string,
  job: JobDetail,
): ToolErrorReturn | null {
  const analysis = buildJobPolicyAnalysis(job);
  const windows = analysis.interviewWindows;
  // 该岗位没配面试窗口——无校验源，跳过（保留旧行为）
  if (windows.length === 0) return null;

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
