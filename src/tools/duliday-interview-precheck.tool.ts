import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { formatLocalDate, getTomorrowDate } from '@infra/utils/date.util';
import { getAvailableEducations } from '@tools/duliday/job-booking.contract';
import {
  buildJobPolicyAnalysis,
  InterviewWindow,
  normalizePolicyText,
} from '@tools/duliday/job-policy-parser';

const logger = new Logger('duliday_interview_precheck');

const inputSchema = z.object({
  jobId: z.number().describe('岗位 ID'),
  requestedDate: z
    .string()
    .optional()
    .describe(
      '候选人想约的日期。支持 today、tomorrow、今天、明天、后天、本周X、下周X、4月12日、YYYY-MM-DD',
    ),
});

const FIELD_ORDER = [
  '姓名',
  '联系电话',
  '性别',
  '年龄',
  '学历',
  '健康证情况',
  '是否学生',
  '过往公司+岗位+年限',
  '面试时间',
  '应聘门店',
  '应聘岗位',
];

const FIELD_LABELS: Record<string, string> = {
  联系电话: '联系方式',
  健康证情况: '健康证',
};

const GENDER_ENUM_HINTS = [
  { id: 1, label: '男' },
  { id: 2, label: '女' },
];

const HEALTH_CERT_ENUM_HINTS = [
  { id: 1, label: '有' },
  { id: 2, label: '无但接受办理健康证' },
  { id: 3, label: '无且不接受办理健康证' },
];

function normalizeRequestedDate(input?: string): {
  date: string | null;
  normalizedInput: string | null;
  error?: string;
} {
  const raw = normalizePolicyText(input);
  if (!raw) return { date: null, normalizedInput: null };
  const normalizedInput = raw.toLowerCase();
  const today = formatLocalDate(new Date());

  if (normalizedInput === 'today' || raw === '今天') {
    return { date: today, normalizedInput };
  }
  if (normalizedInput === 'tomorrow' || raw === '明天') {
    return { date: getTomorrowDate(), normalizedInput };
  }
  if (raw === '后天') {
    return { date: shiftDate(today, 2), normalizedInput };
  }

  const weeklyDate = resolveWeeklyDateExpression(raw, today);
  if (weeklyDate) {
    return { date: weeklyDate, normalizedInput };
  }

  const monthDay = raw.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (monthDay) {
    const resolved = resolveMonthDayToNearestFutureDate(
      Number(monthDay[1]),
      Number(monthDay[2]),
      today,
    );
    if (!resolved) {
      return { date: null, normalizedInput, error: `无法识别的日期：${raw}` };
    }
    return { date: resolved, normalizedInput };
  }

  const fullDate = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (fullDate) {
    const formatted = toDateString(Number(fullDate[1]), Number(fullDate[2]), Number(fullDate[3]));
    if (!formatted) {
      return { date: null, normalizedInput, error: `无法识别的日期：${raw}` };
    }
    return { date: formatted, normalizedInput };
  }

  const normalized = raw.replace(/\//g, '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return { date: normalized, normalizedInput };
  }

  return { date: null, normalizedInput, error: `无法识别的日期：${raw}` };
}

function getWeekdayIndexFromChinese(token: string): number | null {
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 7,
    天: 7,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    5: 5,
    6: 6,
    7: 7,
  };
  return map[token] ?? null;
}

function getWeekdayIndexByDate(dateStr: string): number {
  const weekday = getShanghaiWeekday(dateStr);
  const map: Record<string, number> = {
    每周一: 1,
    每周二: 2,
    每周三: 3,
    每周四: 4,
    每周五: 5,
    每周六: 6,
    每周日: 7,
  };
  return map[weekday] ?? 1;
}

function resolveWeeklyDateExpression(raw: string, today: string): string | null {
  const thisWeekMatch = raw.match(/^(本周|这周|本星期|这星期)([一二三四五六日天1-7])$/);
  if (thisWeekMatch) {
    return resolveDateFromWeekday(today, thisWeekMatch[2], {
      weekOffset: 0,
      keepPastInCurrentWeek: true,
    });
  }

  const nextWeekMatch = raw.match(/^(下周|下星期)([一二三四五六日天1-7])$/);
  if (nextWeekMatch) {
    return resolveDateFromWeekday(today, nextWeekMatch[2], {
      weekOffset: 1,
      keepPastInCurrentWeek: true,
    });
  }

  const plainWeekMatch = raw.match(/^(周|星期)([一二三四五六日天1-7])$/);
  if (plainWeekMatch) {
    return resolveDateFromWeekday(today, plainWeekMatch[2], {
      weekOffset: 0,
      keepPastInCurrentWeek: false,
    });
  }

  return null;
}

function resolveDateFromWeekday(
  today: string,
  weekdayToken: string,
  options: { weekOffset: number; keepPastInCurrentWeek: boolean },
): string | null {
  const targetWeekday = getWeekdayIndexFromChinese(weekdayToken);
  if (!targetWeekday) return null;

  const currentWeekday = getWeekdayIndexByDate(today);
  const monday = shiftDate(today, -(currentWeekday - 1));
  let target = shiftDate(monday, targetWeekday - 1 + options.weekOffset * 7);

  if (!options.keepPastInCurrentWeek && target < today) {
    target = shiftDate(target, 7);
  }

  return target;
}

function toDateString(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function resolveMonthDayToNearestFutureDate(
  month: number,
  day: number,
  today: string,
): string | null {
  const currentYear = Number(today.slice(0, 4));
  const thisYear = toDateString(currentYear, month, day);
  if (thisYear && thisYear >= today) return thisYear;
  return toDateString(currentYear + 1, month, day);
}

function formatShanghaiTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatShanghaiDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getShanghaiWeekday(dateStr: string): string {
  const label = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(new Date(`${dateStr}T12:00:00+08:00`));

  const map: Record<string, string> = {
    星期一: '每周一',
    星期二: '每周二',
    星期三: '每周三',
    星期四: '每周四',
    星期五: '每周五',
    星期六: '每周六',
    星期日: '每周日',
    周一: '每周一',
    周二: '每周二',
    周三: '每周三',
    周四: '每周四',
    周五: '每周五',
    周六: '每周六',
    周日: '每周日',
  };

  return map[label] ?? label;
}

function compareTime(a: string, b: string): number {
  return a.localeCompare(b);
}

function shiftDate(dateStr: string, offsetDays: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMillis = Date.UTC(year, month - 1, day) + offsetDays * 24 * 60 * 60 * 1000;
  const shifted = new Date(utcMillis);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeHm(value?: string): string | null {
  if (!value) return null;
  const match = value.match(/(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseCycleDeadlineDay(raw?: string): number | null {
  if (!raw) return null;
  const normalized = raw.trim();
  if (!normalized) return null;

  if (/^-?\d+$/.test(normalized)) return Number(normalized);

  if (normalized === '当天' || normalized === '当日') return 0;
  if (normalized === '前一天' || normalized === '前1天') return -1;
  if (normalized === '前两天' || normalized === '前2天') return -2;

  return null;
}

function normalizeDateTime(raw: string): string | null {
  const normalized = raw.replace(/\//g, '-').trim();
  const dateTimeMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}[:：]\d{2})(?::\d{2})?$/);
  if (!dateTimeMatch) return null;

  const date = dateTimeMatch[1];
  const hm = normalizeHm(dateTimeMatch[2]);
  if (!hm) return null;
  return `${date} ${hm}`;
}

function resolveBookingDeadlineDateTime(
  interviewDate: string,
  window: InterviewWindow,
): string | null {
  if (window.fixedDeadline) {
    const fixed = normalizeDateTime(window.fixedDeadline);
    if (fixed) return fixed;

    const hm = normalizeHm(window.fixedDeadline);
    if (hm) return `${interviewDate} ${hm}`;
  }

  const dayOffset = parseCycleDeadlineDay(window.cycleDeadlineDay);
  const endHm = normalizeHm(window.cycleDeadlineEnd);
  if (dayOffset === null || !endHm) return null;

  const deadlineDate = shiftDate(interviewDate, dayOffset);
  return `${deadlineDate} ${endHm}`;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeGenderValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  if (/(^|[^女])男/.test(text)) return '男';
  if (/女/.test(text)) return '女';
  return text;
}

function normalizeHealthCertificateValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  if (/^有$|有健康证/.test(text)) return '有';
  if (/无但接受办理健康证|可以办健康证|可办健康证|接受办健康证/.test(text)) {
    return '无但接受办理健康证';
  }
  if (/无且不接受办理健康证|不办健康证|不接受办健康证/.test(text)) {
    return '无且不接受办理健康证';
  }
  if (/^无$|没健康证|没有健康证|无健康证/.test(text)) return '无';
  return text;
}

function normalizeEducationValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  const supported = getAvailableEducations();
  if (supported.includes(text)) return text;
  return text;
}

function buildKnownFieldMap(params: {
  contextProfile?: {
    name?: string | null;
    phone?: string | null;
    gender?: string | null;
    age?: string | null;
    is_student?: boolean | null;
    education?: string | null;
    has_health_certificate?: string | null;
  } | null;
  sessionInterviewInfo?: {
    name?: string | null;
    phone?: string | null;
    gender?: string | null;
    age?: string | null;
    interview_time?: string | null;
    is_student?: boolean | null;
    education?: string | null;
    has_health_certificate?: string | null;
    applied_store?: string | null;
    applied_position?: string | null;
  } | null;
  storeName?: string | null;
  jobName?: string | null;
}): Record<string, string> {
  const info = params.sessionInterviewInfo;
  const profile = params.contextProfile;

  const map: Record<string, string | null> = {
    姓名: normalizePolicyText(info?.name) || normalizePolicyText(profile?.name),
    联系电话: normalizePolicyText(info?.phone) || normalizePolicyText(profile?.phone),
    性别: normalizeGenderValue(info?.gender) || normalizeGenderValue(profile?.gender),
    年龄: normalizePolicyText(info?.age) || normalizePolicyText(profile?.age),
    面试时间: normalizePolicyText(info?.interview_time),
    学历: normalizeEducationValue(info?.education) || normalizeEducationValue(profile?.education),
    健康证情况:
      normalizeHealthCertificateValue(info?.has_health_certificate) ||
      normalizeHealthCertificateValue(profile?.has_health_certificate),
    是否学生:
      info?.is_student != null
        ? info.is_student
          ? '是'
          : '否'
        : profile?.is_student != null
          ? profile.is_student
            ? '是'
            : '否'
          : null,
    应聘门店:
      normalizePolicyText(info?.applied_store) || normalizePolicyText(params.storeName) || null,
    应聘岗位:
      normalizePolicyText(info?.applied_position) || normalizePolicyText(params.jobName) || null,
  };

  const result: Record<string, string> = {};
  for (const [field, value] of Object.entries(map)) {
    if (value) result[field] = value;
  }
  return result;
}

function orderFields(fields: string[]): string[] {
  const uniqueFields = dedupeStrings(fields);
  const ordered = FIELD_ORDER.filter((field) => uniqueFields.includes(field));
  const rest = uniqueFields.filter((field) => !FIELD_ORDER.includes(field)).sort();
  return [...ordered, ...rest];
}

function formatTemplateFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function buildChecklistTemplate(params: {
  requiredFields: string[];
  knownFieldMap: Record<string, string>;
  storeName?: string;
  jobName?: string;
}): { displayOrder: string[]; missingFields: string[]; templateText: string } {
  const requiredFields = dedupeStrings(params.requiredFields);
  const requiredDisplayOrder = orderFields(requiredFields);

  const contextFields = ['应聘门店', '应聘岗位'].filter((field) => {
    if (requiredDisplayOrder.includes(field)) return false;
    if (field === '应聘门店') return Boolean(normalizePolicyText(params.storeName));
    if (field === '应聘岗位') return Boolean(normalizePolicyText(params.jobName));
    return false;
  });
  const displayOrder = [...requiredDisplayOrder, ...contextFields];

  const missingFields = requiredDisplayOrder.filter((field) => !params.knownFieldMap[field]);

  const lines = [
    '面试模板：',
    '面试要求：先将以下资料补充下发给我，我来帮你约面试',
    ...displayOrder.map((field) => {
      const value = params.knownFieldMap[field] ?? '';
      return `${formatTemplateFieldLabel(field)}：${value}`;
    }),
  ];

  return {
    displayOrder,
    missingFields,
    templateText: lines.join('\n'),
  };
}

function buildTimeOption(
  date: string,
  window: InterviewWindow,
): {
  date: string;
  weekday: string;
  startTime: string;
  endTime: string;
  bookingDeadline: string | null;
  label: string;
} {
  const weekday = getShanghaiWeekday(date).replace('每周', '周');
  const bookingDeadline = resolveBookingDeadlineDateTime(date, window);
  const label = bookingDeadline
    ? `${date} ${weekday} ${window.startTime}-${window.endTime}（报名截止 ${bookingDeadline}）`
    : `${date} ${weekday} ${window.startTime}-${window.endTime}`;

  return {
    date,
    weekday,
    startTime: window.startTime,
    endTime: window.endTime,
    bookingDeadline,
    label,
  };
}

function buildCandidateTimeOptions(params: {
  windows: InterviewWindow[];
  requestedDate: string | null;
  horizonDays?: number;
  maxOptions?: number;
}): Array<{
  date: string;
  weekday: string;
  startTime: string;
  endTime: string;
  bookingDeadline: string | null;
  label: string;
}> {
  const { windows, requestedDate, horizonDays = 14, maxOptions = 12 } = params;
  const today = formatLocalDate(new Date());
  const options: Array<{
    date: string;
    weekday: string;
    startTime: string;
    endTime: string;
    bookingDeadline: string | null;
    label: string;
  }> = [];

  if (requestedDate) {
    for (const window of windows) {
      if (window.date && window.date !== requestedDate) continue;
      if (window.weekday && window.weekday !== getShanghaiWeekday(requestedDate)) continue;
      options.push(buildTimeOption(requestedDate, window));
    }
    return dedupeTimeOptions(options);
  }

  for (const window of windows) {
    if (window.date && window.date >= today) {
      options.push(buildTimeOption(window.date, window));
      continue;
    }

    if (!window.weekday) continue;
    for (let i = 0; i <= horizonDays; i += 1) {
      const candidateDate = shiftDate(today, i);
      if (window.weekday !== getShanghaiWeekday(candidateDate)) continue;
      options.push(buildTimeOption(candidateDate, window));
    }
  }

  return dedupeTimeOptions(options)
    .sort((a, b) =>
      a.date === b.date ? compareTime(a.startTime, b.startTime) : a.date.localeCompare(b.date),
    )
    .slice(0, maxOptions);
}

function dedupeTimeOptions(
  options: Array<{
    date: string;
    weekday: string;
    startTime: string;
    endTime: string;
    bookingDeadline: string | null;
    label: string;
  }>,
): Array<{
  date: string;
  weekday: string;
  startTime: string;
  endTime: string;
  bookingDeadline: string | null;
  label: string;
}> {
  const seen = new Set<string>();
  const result: typeof options = [];
  for (const option of options) {
    const key = `${option.date}|${option.startTime}|${option.endTime}|${option.bookingDeadline ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(option);
  }
  return result;
}

function evaluateRequestedDate(params: {
  date: string;
  windows: InterviewWindow[];
  basePolicyNotes?: string[];
}): {
  status: 'available' | 'unavailable' | 'needs_confirmation';
  canSchedule: boolean | null;
  matchedWindows: InterviewWindow[];
  reason: string;
  policyNotes: string[];
  decisionBasis:
    | 'no_matching_schedule'
    | 'after_booking_deadline'
    | 'future_schedule_match'
    | 'same_day_after_latest_window'
    | 'same_day_window_requires_confirmation';
} {
  const { date, windows, basePolicyNotes = [] } = params;
  const weekday = getShanghaiWeekday(date);
  const now = new Date();
  const today = formatShanghaiDate(now);
  const nowTime = formatShanghaiTime(now);
  const nowDateTime = `${today} ${nowTime}`;
  const matchedWindows = windows.filter((window) => {
    if (window.date) return window.date === date;
    if (window.weekday) return window.weekday === weekday;
    return false;
  });

  if (matchedWindows.length === 0) {
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows: [],
      reason: `${date} 没有可预约的面试时段`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'no_matching_schedule',
    };
  }

  const deadlineChecks = matchedWindows.map((window) => {
    const deadlineDateTime = resolveBookingDeadlineDateTime(date, window);
    const expired = deadlineDateTime ? nowDateTime.localeCompare(deadlineDateTime) > 0 : false;
    return { window, deadlineDateTime, expired };
  });
  const hasExplicitDeadlines = deadlineChecks.some((item) => Boolean(item.deadlineDateTime));
  const validDeadlineWindows = deadlineChecks
    .filter((item) => !item.deadlineDateTime || !item.expired)
    .map((item) => item.window);
  const expiredDeadlines = deadlineChecks
    .filter((item) => item.deadlineDateTime && item.expired)
    .map((item) => item.deadlineDateTime as string);

  if (hasExplicitDeadlines && validDeadlineWindows.length === 0) {
    const latestDeadline = expiredDeadlines.sort((a, b) => a.localeCompare(b)).pop();
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows: [],
      reason: latestDeadline
        ? `已超过报名截止时间（最晚截止：${latestDeadline}）`
        : '已超过报名截止时间',
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'after_booking_deadline',
    };
  }

  const effectiveWindows = validDeadlineWindows.length > 0 ? validDeadlineWindows : matchedWindows;

  if (date !== today) {
    return {
      status: 'available',
      canSchedule: true,
      matchedWindows: effectiveWindows,
      reason: `${date} 有可预约的面试时段`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'future_schedule_match',
    };
  }

  const latestEnd = effectiveWindows
    .map((window) => window.endTime || window.startTime)
    .sort((a, b) => compareTime(a, b))
    .pop();

  if (latestEnd && compareTime(nowTime, latestEnd) > 0) {
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows: effectiveWindows,
      reason: `今天的面试时段已结束（最晚到 ${latestEnd}）`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'same_day_after_latest_window',
    };
  }

  return {
    status: 'needs_confirmation',
    canSchedule: null,
    matchedWindows: effectiveWindows,
    reason: '今天有面试时段，是否还能预约需以预约接口结果为准',
    policyNotes: [...basePolicyNotes],
    decisionBasis: 'same_day_window_requires_confirmation',
  };
}

export function buildInterviewPrecheckTool(spongeService: SpongeService): ToolBuilder {
  return (context) =>
    tool({
      description:
        '面试前置校验。根据岗位 ID 读取真实招聘要求和面试流程，返回：今天/指定日期能不能约、可约时段、报名截止时间是否已过、备注解析后的字段建议与规则重点。这个工具负责解释岗位规则，不负责真正提交预约。',
      inputSchema,
      execute: async ({ jobId, requestedDate }) => {
        logger.log(`面试前置校验: jobId=${jobId}, requestedDate=${requestedDate ?? 'none'}`);

        const normalizedDate = normalizeRequestedDate(requestedDate);
        if (normalizedDate.error) {
          return {
            success: false,
            errorType: 'invalid_requested_date',
            error: normalizedDate.error,
          };
        }

        try {
          const { jobs } = await spongeService.fetchJobs({
            jobIdList: [jobId],
            pageNum: 1,
            pageSize: 1,
            options: {
              includeBasicInfo: true,
              includeHiringRequirement: true,
              includeInterviewProcess: true,
            },
          });

          const job = jobs[0];
          if (!job?.basicInfo) {
            return {
              success: false,
              errorType: 'job_not_found',
              error: `未找到 jobId=${jobId} 对应的岗位`,
            };
          }

          const analysis = buildJobPolicyAnalysis(job);
          const windows = analysis.interviewWindows;
          const requestedDateCheck = normalizedDate.date
            ? evaluateRequestedDate({
                date: normalizedDate.date,
                windows,
                basePolicyNotes: analysis.highlights.timingHighlights,
              })
            : {
                status: 'needs_confirmation' as const,
                canSchedule: null,
                matchedWindows: windows,
                reason: '未指定日期，仅返回岗位面试规则与字段建议',
                policyNotes: [...analysis.highlights.timingHighlights],
                decisionBasis: 'date_not_provided' as const,
              };

          const storeInfo = job.basicInfo?.storeInfo ?? null;
          const storeName =
            storeInfo && typeof storeInfo.storeName === 'string'
              ? normalizePolicyText(storeInfo.storeName)
              : '';
          const jobName = normalizePolicyText(job.basicInfo.jobName || job.basicInfo.jobNickName);
          const knownFieldMap = buildKnownFieldMap({
            contextProfile: context.profile ?? null,
            sessionInterviewInfo: context.sessionFacts?.interview_info ?? null,
            storeName,
            jobName,
          });

          const requiredFields = dedupeStrings([
            ...analysis.fieldGuidance.bookingSubmissionFields,
            ...analysis.fieldGuidance.screeningFields,
          ]);
          const checklist = buildChecklistTemplate({
            requiredFields,
            knownFieldMap,
            storeName,
            jobName,
          });

          const candidateTimeOptions = buildCandidateTimeOptions({
            windows,
            requestedDate: normalizedDate.date,
          });

          const nextAction:
            | 'collect_fields'
            | 'confirm_date'
            | 'date_unavailable'
            | 'ready_to_book' =
            requestedDateCheck.status === 'unavailable'
              ? 'date_unavailable'
              : checklist.missingFields.length > 0
                ? 'collect_fields'
                : !normalizedDate.date || requestedDateCheck.status === 'needs_confirmation'
                  ? 'confirm_date'
                  : 'ready_to_book';

          return {
            success: true,
            job: {
              jobId,
              brandName: normalizePolicyText(job.basicInfo.brandName),
              storeName,
              jobName,
            },
            interview: {
              method: analysis.interviewMeta.method,
              address: analysis.interviewMeta.address,
              demand: analysis.interviewMeta.demand,
              timeHint: analysis.interviewMeta.timeHint,
              registrationDeadlineHint: analysis.interviewMeta.registrationDeadlineHint,
              scheduleWindows: windows,
              candidateTimeOptions,
              requestedDateInput: requestedDate ?? null,
              normalizedRequestedDate: normalizedDate.date,
              requestedDate: normalizedDate.date,
              requestedDateStatus: requestedDateCheck.status,
              canScheduleOnRequestedDate: requestedDateCheck.canSchedule,
              requestedDateReason: requestedDateCheck.reason,
              requestedDateMatchedWindows: requestedDateCheck.matchedWindows,
              requestedDateDecisionBasis: requestedDateCheck.decisionBasis,
              policyNotes: requestedDateCheck.policyNotes,
            },
            nextAction,
            requirements: analysis.normalizedRequirements,
            policyHighlights: {
              requirementHighlights: analysis.highlights.requirementHighlights,
              timingHighlights: analysis.highlights.timingHighlights,
            },
            fieldGuidance: {
              ...analysis.fieldGuidance,
              fieldSignals: analysis.fieldGuidance.fieldSignals,
              enumHints: {
                genderId: GENDER_ENUM_HINTS,
                hasHealthCertificate: HEALTH_CERT_ENUM_HINTS,
                education: getAvailableEducations(),
              },
              sourceSummary: dedupeStrings(
                analysis.fieldGuidance.fieldSignals.map(
                  (signal) => `${signal.field} <- ${signal.sourceField}`,
                ),
              ),
            },
            bookingChecklist: {
              requiredFields,
              missingFields: checklist.missingFields,
              displayOrder: checklist.displayOrder,
              knownFieldMap,
              templateText: checklist.templateText,
            },
          };
        } catch (err) {
          logger.error('面试前置校验失败', err);
          return {
            success: false,
            errorType: 'precheck_failed',
            error: `面试前置校验失败: ${err instanceof Error ? err.message : '未知错误'}`,
          };
        }
      },
    });
}
