import { formatLocalDate } from '@infra/utils/date.util';
import { JobDetail } from '@sponge/sponge.types';
import { API_BOOKING_SUBMISSION_FIELDS } from '@tools/duliday/job-booking.contract';

export interface InterviewWindow {
  weekday?: string;
  date?: string;
  startTime: string;
  endTime: string;
}

export type PolicySignalConfidence = 'high' | 'medium';

export type PolicySourceField =
  | 'basic_personal_requirements'
  | 'certificate'
  | 'hiring_remark'
  | 'figure'
  | 'interview_supplement'
  | 'api_submission_contract';

export interface PolicyFieldSignal {
  field: string;
  sourceField: PolicySourceField;
  evidence: string;
  confidence: PolicySignalConfidence;
}

export interface FieldGuidance {
  screeningFields: string[];
  bookingSubmissionFields: string[];
  bookingSubmissionSource: 'api_submission_contract';
  deferredSubmissionFields: string[];
  recommendedAskNowFields: string[];
  fieldSignals: PolicyFieldSignal[];
}

export interface JobPolicyAnalysis {
  interviewWindows: InterviewWindow[];
  fieldGuidance: FieldGuidance;
  normalizedRequirements: {
    genderRequirement: string;
    ageRequirement: string;
    educationRequirement: string;
    healthCertificateRequirement: string;
    remark: string | null;
    interviewRemark: string | null;
    interviewSupplements: string[];
  };
  interviewMeta: {
    method: string | null;
    address: string | null;
    demand: string | null;
    timeHint: string | null;
  };
  highlights: {
    requirementHighlights: string[];
    timingHighlights: string[];
  };
}

type UnknownRecord = Record<string, unknown>;

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizePolicyText(value: string | null | undefined): string {
  if (!value) return '';
  return value.trim();
}

export function cleanPolicyText(text: string): string {
  if (!text) return '';
  return text
    .replace(/辛苦跟.*?[。！？]/g, '')
    .replace(/务必.*?[。！？]/g, '')
    .replace(/手动输入/g, '')
    .replace(/！{2,}/g, '！')
    .replace(/[\n\r]+/g, '；')
    .replace(/；{2,}/g, '；')
    .replace(/^；+|；+$/g, '');
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function pickKeySentences(
  text: string | null | undefined,
  patterns: RegExp[],
  limit = 2,
): string[] {
  if (!hasValue(text) || typeof text !== 'string') return [];

  const fragments = cleanPolicyText(text)
    .split(/[；。]/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);

  const matched: string[] = [];
  for (const fragment of fragments) {
    if (patterns.some((pattern) => pattern.test(fragment)) && !matched.includes(fragment)) {
      matched.push(fragment);
    }
    if (matched.length >= limit) break;
  }
  return matched;
}

function getCurrentMonthDay(): { month: number; day: number } {
  const [, month, day] = formatLocalDate(new Date()).split('-').map(Number);
  return { month, day };
}

function isClearlyPastConstraint(fragment: string): boolean {
  const currentDate = formatLocalDate(new Date());
  const [currentYear, currentMonth, currentDay] = currentDate.split('-').map(Number);

  const yearMatches = [...fragment.matchAll(/\b(20\d{2})[/-](\d{1,2})[/-]?(\d{0,2})?/g)];
  if (yearMatches.length > 0) {
    return yearMatches.every((match) => {
      const year = Number(match[1]);
      const month = Number(match[2] || 1);
      const day = Number(match[3] || 1);
      if (year !== currentYear) return year < currentYear;
      if (month !== currentMonth) return month < currentMonth;
      return day < currentDay;
    });
  }

  const monthDayMatches = [...fragment.matchAll(/(^|[^0-9])(\d{1,2})\/(\d{1,2})(?!\d)/g)];
  if (monthDayMatches.length === 0) return false;

  return monthDayMatches.every((match) => {
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month !== currentMonth) return month < currentMonth;
    return day < currentDay;
  });
}

function isClearlyExpiredSpringFestivalConstraint(fragment: string): boolean {
  const { month, day } = getCurrentMonthDay();
  const isClearlyOutOfSeason = month > 3 && month < 10;
  const isLateAfterFestival = month === 3 && day >= 1;
  if (!isClearlyOutOfSeason && !isLateAfterFestival) return false;

  const normalized = cleanPolicyText(fragment).replace(/\s+/g, '');
  return [
    /过年[^，；。]*返乡/,
    /春节[^，；。]*返乡/,
    /返乡[^，；。]*(过年|春节)/,
    /(过年|春节)[^，；。]*(留岗|留年|在岗)/,
    /过年不返乡/,
    /春节不返乡/,
    /过年不回家/,
    /春节不回家/,
    /年后返岗/,
    /年后到岗/,
    /(过年|春节)[^，；。]*(返岗|到岗)/,
  ].some((pattern) => pattern.test(normalized));
}

export function sanitizeConstraintText(text: string | null | undefined): string | null {
  if (!hasValue(text) || typeof text !== 'string') return null;

  const parts = cleanPolicyText(text)
    .split(/[，；]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      if (isClearlyPastConstraint(part)) return false;
      if (/过期不再办理|最后入职时间|面试完毕/.test(part)) return false;
      if (isClearlyExpiredSpringFestivalConstraint(part)) return false;
      return true;
    });

  const sanitized = parts.join('，').trim();
  return sanitized || null;
}

export function extractInterviewWindows(
  interviewProcess: UnknownRecord | null | undefined,
): InterviewWindow[] {
  const first = asRecord(interviewProcess?.firstInterview);
  if (!first) return [];

  const windows: InterviewWindow[] = [];

  for (const item of asArray(first.periodicInterviewTimes)) {
    const periodic = asRecord(item);
    if (!periodic) continue;

    const weekday = normalizePolicyText(asString(periodic.interviewWeekday));
    for (const time of asArray(periodic.interviewTimes)) {
      const timeRecord = asRecord(time);
      if (!timeRecord) continue;

      const startTime = normalizePolicyText(asString(timeRecord.interviewStartTime));
      const endTime = normalizePolicyText(
        asString(timeRecord.interviewEndTime) ?? asString(timeRecord.interviewStartTime),
      );
      if (!startTime) continue;
      windows.push({ weekday, startTime, endTime: endTime || startTime });
    }
  }

  for (const item of asArray(first.fixedInterviewTimes)) {
    const fixed = asRecord(item);
    if (!fixed) continue;

    const date = normalizePolicyText(asString(fixed.interviewDate));
    const startTime = normalizePolicyText(asString(fixed.interviewStartTime));
    const endTime = normalizePolicyText(
      asString(fixed.interviewEndTime) ?? asString(fixed.interviewStartTime),
    );
    if (!date || !startTime) continue;
    windows.push({ date, startTime, endTime: endTime || startTime });
  }

  return windows;
}

function mapSupplementToField(supplement: string): string | null {
  if (/健康证/.test(supplement)) return '健康证情况';
  if (/过往公司|岗位|年限|工作经历|经验/.test(supplement)) return '过往公司+岗位+年限';
  if (/学历/.test(supplement)) return '学历';
  if (/学生/.test(supplement)) return '是否学生';
  if (/姓名/.test(supplement)) return '姓名';
  if (/电话|联系方式/.test(supplement)) return '联系电话';
  if (/年龄/.test(supplement)) return '年龄';
  if (/性别/.test(supplement)) return '性别';
  return null;
}

function buildFieldSignals(job: JobDetail): PolicyFieldSignal[] {
  const signals: PolicyFieldSignal[] = [];
  const hiringRequirement = asRecord(job.hiringRequirement);
  const basic = asRecord(hiringRequirement?.basicPersonalRequirements);
  const cert = asRecord(hiringRequirement?.certificate);
  const interviewProcess = asRecord(job.interviewProcess);
  const remark = normalizePolicyText(asString(hiringRequirement?.remark));
  const figure = normalizePolicyText(asString(hiringRequirement?.figure));

  if (asNumber(basic?.minAge) != null || asNumber(basic?.maxAge) != null) {
    signals.push({
      field: '年龄',
      sourceField: 'basic_personal_requirements',
      evidence: `${asNumber(basic?.minAge) ?? '不限'}-${asNumber(basic?.maxAge) ?? '不限'}岁`,
      confidence: 'high',
    });
  }

  const genderRequirement = normalizePolicyText(asString(basic?.genderRequirement));
  if (
    genderRequirement &&
    genderRequirement !== '不限' &&
    !genderRequirement.includes('男性,女性')
  ) {
    signals.push({
      field: '性别',
      sourceField: 'basic_personal_requirements',
      evidence: genderRequirement,
      confidence: 'high',
    });
  }

  const educationRequirement = normalizePolicyText(asString(cert?.education));
  if (educationRequirement && educationRequirement !== '不限') {
    signals.push({
      field: '学历',
      sourceField: 'certificate',
      evidence: educationRequirement,
      confidence: 'high',
    });
  }

  const healthRequirement = normalizePolicyText(asString(cert?.healthCertificate));
  if (healthRequirement || normalizePolicyText(asString(cert?.certificates)).includes('健康证')) {
    signals.push({
      field: '健康证情况',
      sourceField: 'certificate',
      evidence: healthRequirement || normalizePolicyText(asString(cert?.certificates)),
      confidence: 'high',
    });
  }

  for (const item of asArray(interviewProcess?.interviewSupplement)) {
    const supplement = normalizePolicyText(asString(asRecord(item)?.interviewSupplement));
    const mapped = mapSupplementToField(supplement);
    if (!mapped) continue;
    signals.push({
      field: mapped,
      sourceField: 'interview_supplement',
      evidence: supplement,
      confidence: 'medium',
    });
  }

  if (/经验|体力劳动|分拣经验/.test(remark)) {
    signals.push({
      field: '过往公司+岗位+年限',
      sourceField: 'hiring_remark',
      evidence: remark,
      confidence: 'medium',
    });
  }

  if (/社会人士/.test(figure) || /学生/.test(remark)) {
    signals.push({
      field: '是否学生',
      sourceField: /社会人士/.test(figure) ? 'figure' : 'hiring_remark',
      evidence: /社会人士/.test(figure) ? figure : remark,
      confidence: 'medium',
    });
  }

  return signals;
}

export function buildFieldGuidance(job: JobDetail): FieldGuidance {
  const fieldSignals = buildFieldSignals(job);
  const screeningFields = dedupeStrings(fieldSignals.map((signal) => signal.field));
  const bookingSubmissionFields = [...API_BOOKING_SUBMISSION_FIELDS];
  const deferredSubmissionFields = bookingSubmissionFields.filter(
    (field) =>
      !screeningFields.includes(field) &&
      !['姓名', '联系电话', '性别', '年龄', '面试时间'].includes(field),
  );

  return {
    screeningFields,
    bookingSubmissionFields,
    bookingSubmissionSource: 'api_submission_contract',
    deferredSubmissionFields,
    recommendedAskNowFields: dedupeStrings([...screeningFields, '姓名', '联系电话', '面试时间']),
    fieldSignals,
  };
}

function extractInterviewTimeHint(job: JobDetail): string | null {
  const interviewProcess = asRecord(job.interviewProcess);
  if (!interviewProcess) return null;

  const first = asRecord(interviewProcess.firstInterview);
  const texts = [
    asString(first?.interviewTime),
    asString(first?.interviewDate),
    asString(first?.interviewDemand),
    asString(interviewProcess.remark),
  ].filter((text): text is string => Boolean(text));

  const timePatterns = [
    /星期[一二三四五六日天]/,
    /周[一二三四五六日天]/,
    /\d{1,2}[:：]\d{2}/,
    /上午|下午|晚上|中午/,
  ];

  for (const text of texts) {
    const [fragment] = pickKeySentences(text, timePatterns, 1);
    if (fragment) return fragment;
  }

  return null;
}

export function buildJobPolicyAnalysis(job: JobDetail): JobPolicyAnalysis {
  const hiringRequirement = asRecord(job.hiringRequirement);
  const basic = asRecord(hiringRequirement?.basicPersonalRequirements);
  const cert = asRecord(hiringRequirement?.certificate);
  const interviewProcess = asRecord(job.interviewProcess);
  const firstInterview = asRecord(interviewProcess?.firstInterview);
  const interviewSupplements = asArray(interviewProcess?.interviewSupplement)
    .map((item) => normalizePolicyText(asString(asRecord(item)?.interviewSupplement)))
    .filter(Boolean);

  const requirementRemark = sanitizeConstraintText(asString(hiringRequirement?.remark));
  const interviewRemark = sanitizeConstraintText(asString(interviewProcess?.remark));
  const interviewDemand = sanitizeConstraintText(asString(firstInterview?.interviewDemand));

  const requirementHighlights = pickKeySentences(asString(hiringRequirement?.remark), [
    /经验/,
    /体力/,
    /分拣/,
    /健康证/,
    /学历/,
    /学生/,
    /夜班/,
  ])
    .map((fragment) => sanitizeConstraintText(fragment))
    .filter((fragment): fragment is string => Boolean(fragment));

  const timingHighlights = pickKeySentences(asString(interviewProcess?.remark), [
    /健康证/,
    /最迟/,
    /最后/,
    /截止/,
    /过期/,
    /完成面试/,
    /入职/,
  ])
    .map((fragment) => sanitizeConstraintText(fragment))
    .filter((fragment): fragment is string => Boolean(fragment));

  return {
    interviewWindows: extractInterviewWindows(interviewProcess),
    fieldGuidance: buildFieldGuidance(job),
    normalizedRequirements: {
      genderRequirement: normalizePolicyText(asString(basic?.genderRequirement)) || '不限',
      ageRequirement:
        asNumber(basic?.minAge) != null || asNumber(basic?.maxAge) != null
          ? `${asNumber(basic?.minAge) ?? '不限'}-${asNumber(basic?.maxAge) ?? '不限'}岁`
          : '不限',
      educationRequirement: normalizePolicyText(asString(cert?.education)) || '不限',
      healthCertificateRequirement:
        normalizePolicyText(asString(cert?.healthCertificate)) || '未明确要求',
      remark: requirementRemark,
      interviewRemark,
      interviewSupplements,
    },
    interviewMeta: {
      method: normalizePolicyText(asString(firstInterview?.firstInterviewWay)) || null,
      address: normalizePolicyText(asString(firstInterview?.interviewAddress)) || null,
      demand: interviewDemand,
      timeHint: extractInterviewTimeHint(job),
    },
    highlights: {
      requirementHighlights,
      timingHighlights,
    },
  };
}
