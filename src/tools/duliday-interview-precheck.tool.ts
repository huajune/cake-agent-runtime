import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { formatLocalDate, getTomorrowDate } from '@infra/utils/date.util';
import { stripNullish } from '@infra/utils/object.util';
import { getAvailableEducations } from '@tools/duliday/job-booking.contract';
import {
  buildJobPolicyAnalysis,
  InterviewWindow,
  JobPolicyAnalysis,
  normalizePolicyText,
} from '@tools/duliday/job-policy-parser';

const logger = new Logger('duliday_interview_precheck');

const inputSchema = z.object({
  jobId: z.number().describe('岗位 ID'),
  requestedDate: z
    .string()
    .optional()
    .describe(
      '仅当候选人在对话中明确说出想约的具体日期时才传入。候选人只是泛泛询问"什么时候能面试"时不要传。' +
        '支持 today、tomorrow、今天、明天、后天、本周X、下周X、4月12日、YYYY-MM-DD。',
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

const TEMPLATE_CORE_FIELDS = ['姓名', '联系电话', '性别', '年龄', '应聘门店'];

const FIELD_LABELS: Record<string, string> = {
  联系电话: '联系方式',
  健康证情况: '健康证',
};

const GENDER_ENUM_HINTS = ['男', '女'];

const HEALTH_CERT_ENUM_HINTS = ['有', '无但接受办理健康证', '无且不接受办理健康证'];

const SHORT_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

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
}): { displayOrder: string[]; missingFields: string[]; templateText: string } {
  const requiredFields = dedupeStrings(params.requiredFields);
  const requiredDisplayOrder = orderFields(requiredFields);
  const dynamicFields = orderFields(
    requiredDisplayOrder.filter((field) => !TEMPLATE_CORE_FIELDS.includes(field)),
  );
  const displayOrder = [...TEMPLATE_CORE_FIELDS, ...dynamicFields];

  const missingFields = displayOrder.filter((field) => !params.knownFieldMap[field]);

  const lines = [
    '面试模版：',
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

/**
 * 生成未来 horizonDays 天内实际可约的面试时段（扁平 label 数组），不受 requestedDate 影响。
 * - 过滤已过报名截止的时段
 * - 今日时段会标注"今日"
 * - 上限 maxOptions 条
 */
function buildUpcomingTimeOptions(
  windows: InterviewWindow[],
  horizonDays = 7,
  maxOptions = 10,
): string[] {
  if (windows.length === 0) return [];

  const now = new Date();
  const today = formatLocalDate(now);
  const nowTime = formatShanghaiTime(now);
  const nowDateTime = `${today} ${nowTime}`;

  type Option = {
    date: string;
    startTime: string;
    endTime: string;
    deadline: string | null;
    label: string;
  };
  const options: Option[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < horizonDays; i += 1) {
    const date = shiftDate(today, i);
    const weekday = getShanghaiWeekday(date);

    for (const window of windows) {
      if (window.date && window.date !== date) continue;
      if (!window.date && window.weekday && window.weekday !== weekday) continue;
      if (!window.date && !window.weekday) continue;

      const deadline = resolveBookingDeadlineDateTime(date, window);
      if (deadline && nowDateTime.localeCompare(deadline) > 0) continue;

      const key = `${date}|${window.startTime}|${window.endTime}|${deadline ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const weekdayShort = weekday.replace('每周', '周');
      const isToday = date === today;
      const deadlineText = deadline
        ? isToday
          ? `报名截止 ${deadline.slice(11)}` // 今日只保留 HH:mm
          : `报名截止 ${deadline}`
        : '';
      const todayTag = isToday ? '今日' : '';
      const suffixParts = [todayTag, deadlineText].filter(Boolean);
      const suffix = suffixParts.length > 0 ? `（${suffixParts.join('，')}）` : '';

      options.push({
        date,
        startTime: window.startTime,
        endTime: window.endTime,
        deadline,
        label: `${date} ${weekdayShort} ${window.startTime}-${window.endTime}${suffix}`,
      });
    }
  }

  options.sort((a, b) =>
    a.date === b.date ? compareTime(a.startTime, b.startTime) : a.date.localeCompare(b.date),
  );

  return options.slice(0, maxOptions).map((option) => option.label);
}

/**
 * 将周期性面试窗口压缩为人类可读的规则总结。
 * - 同 startTime/endTime/deadline 的窗口按 weekday 合并
 * - 连续 3 天以上用"周一至周五"表示，否则用"周一、三、五"
 * - 固定日期窗口不纳入规则总结（由 upcomingTimeOptions 表达）
 * - 没有任何周期性窗口时返回空字符串
 */
function buildScheduleRule(windows: InterviewWindow[]): string {
  const periodic = windows.filter((window) => window.weekday);
  if (periodic.length === 0) return '';

  const groups = new Map<
    string,
    { windows: InterviewWindow[]; startTime: string; endTime: string }
  >();
  for (const window of periodic) {
    const key = [
      window.startTime,
      window.endTime,
      window.fixedDeadline ?? '',
      window.cycleDeadlineDay ?? '',
      window.cycleDeadlineEnd ?? '',
    ].join('|');
    if (!groups.has(key)) {
      groups.set(key, { windows: [], startTime: window.startTime, endTime: window.endTime });
    }
    groups.get(key)!.windows.push(window);
  }

  const parts: string[] = [];
  for (const group of groups.values()) {
    const weekdayStr = formatWeekdayList(group.windows.map((window) => window.weekday || ''));
    if (!weekdayStr) continue;
    const timeStr = `${group.startTime}-${group.endTime}`;
    const deadlineClause = formatDeadlineClause(group.windows[0]);
    parts.push(
      deadlineClause ? `${weekdayStr} ${timeStr}，${deadlineClause}` : `${weekdayStr} ${timeStr}`,
    );
  }

  return parts.join('；');
}

function formatWeekdayList(weekdays: string[]): string {
  const indices = Array.from(
    new Set(
      weekdays
        .map((weekday) => {
          const match = weekday.match(/[一二三四五六日天]/);
          if (!match) return -1;
          const char = match[0] === '天' ? '日' : match[0];
          return SHORT_WEEKDAYS.indexOf(char);
        })
        .filter((index) => index >= 0),
    ),
  ).sort((a, b) => a - b);

  if (indices.length === 0) return '';

  const isConsecutive = indices.every((value, i) => i === 0 || value === indices[i - 1] + 1);
  if (indices.length >= 3 && isConsecutive) {
    return `周${SHORT_WEEKDAYS[indices[0]]}至周${SHORT_WEEKDAYS[indices[indices.length - 1]]}`;
  }

  return `周${indices.map((index) => SHORT_WEEKDAYS[index]).join('、')}`;
}

function formatDeadlineClause(window: InterviewWindow): string {
  if (window.fixedDeadline) return `截止 ${window.fixedDeadline}`;
  const dayLabel = normalizePolicyText(window.cycleDeadlineDay);
  const endTime = normalizePolicyText(window.cycleDeadlineEnd);
  if (dayLabel && endTime) return `${dayLabel} ${endTime} 前报名`;
  return '';
}

/**
 * 从岗位分析结果构造岗位硬性筛选条件，只保留有值的字段。
 */
function buildScreeningCriteria(analysis: JobPolicyAnalysis): Record<string, string> {
  const req = analysis.normalizedRequirements;
  const result: Record<string, string> = {};

  if (req.genderRequirement && req.genderRequirement !== '不限') {
    result.gender = req.genderRequirement;
  }
  if (req.ageRequirement && req.ageRequirement !== '不限') {
    result.age = req.ageRequirement;
  }
  if (req.educationRequirement && req.educationRequirement !== '不限') {
    result.education = req.educationRequirement;
  }
  if (req.healthCertificateRequirement && req.healthCertificateRequirement !== '未明确要求') {
    result.healthCertificate = req.healthCertificateRequirement;
  }

  const studentSignal = analysis.fieldGuidance.fieldSignals.find(
    (signal) => signal.field === '是否学生',
  );
  if (studentSignal?.evidence) {
    result.isStudent = studentSignal.evidence;
  }

  if (req.remark) result.remark = req.remark;
  if (req.interviewRemark) result.interviewRemark = req.interviewRemark;

  return result;
}

/**
 * 只返回 missingFields 里涉及字段的枚举提示，避免 LLM 已知时还要看全量枚举。
 */
function buildEnumHintsForMissing(missingFields: string[]): Record<string, string[]> {
  const hints: Record<string, string[]> = {};
  if (missingFields.includes('性别')) hints.gender = [...GENDER_ENUM_HINTS];
  if (missingFields.includes('健康证情况')) hints.healthCertificate = [...HEALTH_CERT_ENUM_HINTS];
  if (missingFields.includes('学历')) hints.education = getAvailableEducations();
  return hints;
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
    | 'same_day_before_window'
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

  // 如果所有有效窗口都尚未开始（now < 最早 startTime），且之前已通过报名截止检查，
  // 则今日仍可预约，直接返回 available，不让 LLM 生成暧昧话术。
  const earliestStart = effectiveWindows
    .map((window) => window.startTime)
    .filter(Boolean)
    .sort((a, b) => compareTime(a, b))[0];

  if (earliestStart && compareTime(nowTime, earliestStart) < 0) {
    return {
      status: 'available',
      canSchedule: true,
      matchedWindows: effectiveWindows,
      reason: `今天还可以预约面试（最早时段 ${earliestStart} 开始）`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'same_day_before_window',
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
        '面试前置校验。返回岗位的面试周期规则（scheduleRule）、未来一周可约时段示例（upcomingTimeOptions）、岗位硬性筛选条件（screeningCriteria）、预约所需字段清单和可直接发送的话术模板（bookingChecklist）。如果候选人已经明确提出想约某一天，可以额外传入 requestedDate 让工具单独判定那一天是否可约，但不会影响 upcomingTimeOptions 的内容。这个工具负责解释岗位规则，不负责真正提交预约。',
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
              })
            : null;

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
          });

          const upcomingTimeOptions = buildUpcomingTimeOptions(windows);
          const scheduleRule = buildScheduleRule(windows);
          const screeningCriteria = buildScreeningCriteria(analysis);
          const enumHints = buildEnumHintsForMissing(checklist.missingFields);

          const nextAction:
            | 'collect_fields'
            | 'confirm_date'
            | 'date_unavailable'
            | 'ready_to_book' =
            requestedDateCheck?.status === 'unavailable'
              ? 'date_unavailable'
              : checklist.missingFields.length > 0
                ? 'collect_fields'
                : !requestedDateCheck || requestedDateCheck.status === 'needs_confirmation'
                  ? 'confirm_date'
                  : 'ready_to_book';

          // 内部中间态仅写入 debug 日志，不回传给 LLM
          logger.debug(
            JSON.stringify({
              jobId,
              scheduleWindows: windows,
              fieldSignals: analysis.fieldGuidance.fieldSignals,
              requestedDateDecisionBasis: requestedDateCheck?.decisionBasis ?? null,
            }),
          );

          return stripNullish({
            success: true,
            nextAction,
            job: {
              jobId,
              brandName: normalizePolicyText(job.basicInfo.brandName),
              storeName,
              jobName,
            },
            interview: {
              method: analysis.interviewMeta.method,
              address: analysis.interviewMeta.address,
              scheduleRule,
              upcomingTimeOptions,
              requestedDate: requestedDateCheck
                ? {
                    value: normalizedDate.date,
                    status: requestedDateCheck.status,
                    reason: requestedDateCheck.reason,
                  }
                : null,
            },
            screeningCriteria,
            bookingChecklist: {
              missingFields: checklist.missingFields,
              templateText: checklist.templateText,
              enumHints,
            },
          });
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
