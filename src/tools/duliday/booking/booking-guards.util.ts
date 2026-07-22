/**
 * Booking-time defense-in-depth guards.
 *
 * 设计目的：duliday_interview_booking 工具描述上要求"先调 precheck 再调 booking"，
 * 但 LLM 偶发会跳过 precheck 直接调 booking、或无视 precheck 的 nameFieldGuard /
 * screeningChecks 警告硬塞数据。下列四类硬规则在 precheck 已经做过一次，
 * booking 在调 sponge API 之前再跑一次，作为 server-side 兜底：
 *
 * 1. 真实姓名 (isLikelyRealChineseName)
 *    — badcase 簇 booking_real_name_required (5 cases)
 * 2. 面试时段 (validateInterviewTimeAgainstSchedule)
 *    — badcase 簇 booking_same_day_cutoff (5 cases) + invalid_interview_time_slot
 * 3. 筛选答案 (findScreeningFailure)
 *    — badcase 69e9bba2 (agent 把不合格候选人直接送进 booking)
 * 4. 候选人 facts 与岗位硬性约束冲突 (extractHardRequirements + candidate facts)
 *    — gender / healthCert 两类，从 raw + policy 派生的 enum 与候选人入参对账
 *
 * 与 precheck 共用底层函数（name-guard / interview-window / supplement-label-classifier /
 * hard-requirements），不存在双口径漂移风险；多花的成本是 booking 路径上一次本地数据计算
 * （不增加 sponge 调用）。
 */
import type { JobDetail } from '@sponge/sponge.types';
import { getSpongeProvinceNameById } from '@sponge/sponge.enums';
import { isStrictRealChineseName } from '@memory/facts/name-guard';
import { buildJobPolicyAnalysis, InterviewWindow } from '@tools/utils/job-policy-parser';
import {
  compareTime,
  findSameDayCutoffViolation,
  getShanghaiWeekday,
  isDateOnlyWindow,
  normalizeHm,
  resolveBookingDeadlineDateTime,
} from '@tools/duliday/booking/interview-window.util';
import {
  findScreeningFailure,
  type ScreeningFailure,
} from '@tools/utils/supplement-label-classifier';
import {
  extractHardRequirements,
  isHouseholdRequirementViolated,
  type HardRequirements,
} from '@tools/duliday/job-list/hard-requirements.util';
import {
  buildToolError,
  TOOL_ERROR_TYPES,
  type ToolErrorReturn,
} from '@tools/types/tool-error-types';

export interface BookingGuardInput {
  job: JobDetail;
  name: string;
  /** 面试时间；无面试时段（等通知）岗位合法缺省，缺省时跳过时段校验 */
  interviewTime?: string;
  supplementAnswers?: Record<string, string>;
  /** 候选人性别：1=男，2=女（来自 booking 工具入参） */
  candidateGenderId?: number;
  /** 候选人健康证：1=有，2=无但接受办理，3=无且不接受办理 */
  candidateHasHealthCertificate?: number;
  /** 候选人健康证原始事实，用于防止把“异地证”伪造成 1=有 */
  candidateHealthCertificateFact?: string | null;
  /** 候选人是否学生；true=学生，false=社会人士 */
  candidateIsStudent?: boolean;
  /** 候选人户籍省 ID（来自 booking 工具入参） */
  candidateHouseholdProvinceId?: number;
}

/**
 * 跑完四个 booking guard。命中即返回 ToolErrorReturn；全部通过返回 null。
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

  const hardRequirementFailure = checkHardRequirements(input);
  if (hardRequirementFailure) return hardRequirementFailure;

  return null;
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

/**
 * 比对岗位硬约束与候选人 facts。命中性别 / 户籍 / 健康证等不可妥协场景时拒 booking。
 */
function checkHardRequirements(input: BookingGuardInput): ToolErrorReturn | null {
  const policy = buildJobPolicyAnalysis(input.job);
  const hr: HardRequirements = extractHardRequirements(input.job, policy);

  const genderConflict = detectGenderConflict(hr.gender, input.candidateGenderId);
  if (genderConflict) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
      outcome: '预约失败（候选人性别与岗位硬性约束冲突）',
      replyInstruction:
        '岗位明确限制性别，候选人性别不符，**严禁继续 booking**。先用礼貌话术告知候选人本岗位仅限对方不属于的性别，然后调 duliday_job_list 重新筛同区域其他岗位；或在用户自荐其它意向时调 request_handoff 转人工，让招募经理判断是否破例。不要回头修改 genderId 重试本工具。',
      details: { detailedReason: genderConflict },
    });
  }

  const candidateHouseholdProvince =
    input.candidateHouseholdProvinceId == null
      ? null
      : getSpongeProvinceNameById(input.candidateHouseholdProvinceId);
  if (isHouseholdRequirementViolated(hr.household, candidateHouseholdProvince)) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
      outcome: '预约失败（候选人与岗位内部硬性条件冲突）',
      replyInstruction:
        '候选人与当前岗位的内部硬性条件不匹配，严禁继续 booking。请用中性话术说明当前岗位暂不匹配，并调用 duliday_job_list 转查其它岗位；禁止透露、复述或暗示具体户籍、籍贯或地域限制，也不得修改户籍字段重试。',
      details: {
        detailedReason: '候选人户籍与岗位内部硬约束冲突（敏感条件，仅供内部审计）',
      },
    });
  }

  const healthCertConflict = detectHealthCertConflict(
    hr.healthCert,
    input.candidateHasHealthCertificate,
    input.candidateHealthCertificateFact,
  );
  if (healthCertConflict) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
      outcome: '预约失败（候选人健康证状态不满足岗位硬性约束）',
      replyInstruction: healthCertConflict.replyInstruction,
      details: { detailedReason: healthCertConflict.detailedReason },
    });
  }

  if (hr.student === 'social_only' && input.candidateIsStudent === true) {
    return buildToolError({
      errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
      outcome: '预约失败（候选人学生身份与岗位硬性约束冲突）',
      replyInstruction:
        '当前岗位明确只接受社会人士，候选人已明确是学生，严禁继续 booking。礼貌说明当前岗位暂不匹配，并调用 duliday_job_list 查找接受学生的其它岗位；没有合适岗位时走 invite_to_group 或 request_handoff。不得修改或隐瞒候选人身份重试。',
      details: { detailedReason: '岗位仅接受社会人士，候选人身份=学生' },
    });
  }

  return null;
}

function detectGenderConflict(
  required: HardRequirements['gender'],
  candidateGenderId: number | undefined,
): string | null {
  if (required !== 'male' && required !== 'female') return null;
  if (candidateGenderId !== 1 && candidateGenderId !== 2) return null;
  if (required === 'female' && candidateGenderId === 1) {
    return '岗位限女，候选人性别=男（genderId=1）';
  }
  if (required === 'male' && candidateGenderId === 2) {
    return '岗位限男，候选人性别=女（genderId=2）';
  }
  return null;
}

function detectHealthCertConflict(
  required: HardRequirements['healthCert'],
  candidateHasHealthCertificate: number | undefined,
  candidateHealthCertificateFact?: string | null,
): { detailedReason: string; replyInstruction: string } | null {
  if (required === 'unspecified' || required === 'not_required') return null;
  if (candidateHasHealthCertificate == null) {
    return {
      detailedReason: '岗位已配置健康证要求，booking 未传 hasHealthCertificate',
      replyInstruction:
        '当前岗位已配置健康证要求，但尚未收齐健康证情况，禁止 booking。返回 duliday_interview_precheck 询问候选人：应聘城市本地健康证按 1=有；异地证必须先确认是否接受重办。',
    };
  }

  if (
    candidateHasHealthCertificate === 1 &&
    candidateHealthCertificateFact &&
    /非本地|不是本地|外地|异地/.test(candidateHealthCertificateFact)
  ) {
    return {
      detailedReason: `候选人事实为异地健康证，但 booking 传入 hasHealthCertificate=1`,
      replyInstruction:
        '异地健康证不能按“有本地证”提交。禁止 booking；先询问候选人是否接受录用后重新办理应聘城市本地健康证。接受才能传 2，不接受传 3 并停止本岗位推进。',
    };
  }

  // 面试前必须有：无证（无论是否接受办理）都不应直接 booking
  if (required === 'required_before_interview' && candidateHasHealthCertificate !== 1) {
    return {
      detailedReason: `岗位要求面试前必须持证，候选人 hasHealthCertificate=${candidateHasHealthCertificate}（非 1=有）`,
      replyInstruction:
        '岗位明确要求面试前必须持有健康证，候选人当前无证。**严禁继续 booking**。告诉候选人需先办妥健康证再约面，或调 duliday_job_list 找"入职前办即可/不需要健康证"的同区域岗位；候选人坚持本岗的话调 request_handoff 转人工。',
    };
  }

  // 入职前必须有：候选人"无且不接受办理"才拦
  if (required === 'required_before_onboard' && candidateHasHealthCertificate === 3) {
    return {
      detailedReason: '岗位要求入职前持证，候选人 hasHealthCertificate=3（无且不接受办理）',
      replyInstruction:
        '岗位入职前需办妥健康证，候选人明确不接受办理。**严禁继续 booking**。调 duliday_job_list 找不需要健康证的岗位推荐；候选人坚持本岗则调 request_handoff 转人工。',
    };
  }

  return null;
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
