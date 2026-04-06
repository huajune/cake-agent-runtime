import { formatLocalDate } from '@infra/utils/date.util';
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

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
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

export function extractInterviewWindows(interviewProcess: any): InterviewWindow[] {
  const first = interviewProcess?.firstInterview;
  if (!first) return [];

  const windows: InterviewWindow[] = [];

  if (Array.isArray(first.periodicInterviewTimes)) {
    for (const item of first.periodicInterviewTimes) {
      const weekday = normalizePolicyText(item?.interviewWeekday);
      const times = Array.isArray(item?.interviewTimes) ? item.interviewTimes : [];
      for (const time of times) {
        const startTime = normalizePolicyText(time?.interviewStartTime);
        const endTime = normalizePolicyText(time?.interviewEndTime || time?.interviewStartTime);
        if (!startTime) continue;
        windows.push({ weekday, startTime, endTime: endTime || startTime });
      }
    }
  }

  if (Array.isArray(first.fixedInterviewTimes)) {
    for (const item of first.fixedInterviewTimes) {
      const date = normalizePolicyText(item?.interviewDate);
      const startTime = normalizePolicyText(item?.interviewStartTime);
      const endTime = normalizePolicyText(item?.interviewEndTime || item?.interviewStartTime);
      if (!date || !startTime) continue;
      windows.push({ date, startTime, endTime: endTime || startTime });
    }
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

function buildFieldSignals(job: any): PolicyFieldSignal[] {
  const signals: PolicyFieldSignal[] = [];
  const basic = job?.hiringRequirement?.basicPersonalRequirements;
  const cert = job?.hiringRequirement?.certificate;
  const remark = normalizePolicyText(job?.hiringRequirement?.remark);
  const figure = normalizePolicyText(job?.hiringRequirement?.figure);
  const supplements = Array.isArray(job?.interviewProcess?.interviewSupplement)
    ? job.interviewProcess.interviewSupplement
    : [];

  if (basic?.minAge != null || basic?.maxAge != null) {
    signals.push({
      field: '年龄',
      sourceField: 'basic_personal_requirements',
      evidence: `${basic?.minAge ?? '不限'}-${basic?.maxAge ?? '不限'}岁`,
      confidence: 'high',
    });
  }

  const genderRequirement = normalizePolicyText(basic?.genderRequirement);
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

  const educationRequirement = normalizePolicyText(cert?.education);
  if (educationRequirement && educationRequirement !== '不限') {
    signals.push({
      field: '学历',
      sourceField: 'certificate',
      evidence: educationRequirement,
      confidence: 'high',
    });
  }

  const healthRequirement = normalizePolicyText(cert?.healthCertificate);
  if (healthRequirement || normalizePolicyText(cert?.certificates).includes('健康证')) {
    signals.push({
      field: '健康证情况',
      sourceField: 'certificate',
      evidence: healthRequirement || normalizePolicyText(cert?.certificates),
      confidence: 'high',
    });
  }

  for (const item of supplements) {
    const supplement = normalizePolicyText(item?.interviewSupplement);
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

export function buildFieldGuidance(job: any): FieldGuidance {
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

function extractInterviewTimeHint(job: any): string | null {
  const ip = job?.interviewProcess;
  if (!ip) return null;

  const first = ip.firstInterview;
  const texts = [
    typeof first?.interviewTime === 'string' ? first.interviewTime : null,
    typeof first?.interviewDate === 'string' ? first.interviewDate : null,
    typeof first?.interviewDemand === 'string' ? first.interviewDemand : null,
    typeof ip.remark === 'string' ? ip.remark : null,
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

export function buildJobPolicyAnalysis(job: any): JobPolicyAnalysis {
  const basic = (job?.hiringRequirement?.basicPersonalRequirements ?? null) as any;
  const cert = (job?.hiringRequirement?.certificate ?? null) as any;
  const firstInterview = (job?.interviewProcess?.firstInterview ?? null) as any;
  const interviewSupplements = Array.isArray(job?.interviewProcess?.interviewSupplement)
    ? job.interviewProcess.interviewSupplement
        .map((item: any) => normalizePolicyText(item?.interviewSupplement))
        .filter(Boolean)
    : [];

  const requirementRemark = sanitizeConstraintText(job?.hiringRequirement?.remark);
  const interviewRemark = sanitizeConstraintText(job?.interviewProcess?.remark);
  const interviewDemand = sanitizeConstraintText(firstInterview?.interviewDemand);

  const requirementHighlights = pickKeySentences(job?.hiringRequirement?.remark, [
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

  const timingHighlights = pickKeySentences(job?.interviewProcess?.remark, [
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
    interviewWindows: extractInterviewWindows(job?.interviewProcess),
    fieldGuidance: buildFieldGuidance(job),
    normalizedRequirements: {
      genderRequirement: normalizePolicyText(basic?.genderRequirement) || '不限',
      ageRequirement:
        basic?.minAge != null || basic?.maxAge != null
          ? `${basic?.minAge ?? '不限'}-${basic?.maxAge ?? '不限'}岁`
          : '不限',
      educationRequirement: normalizePolicyText(cert?.education) || '不限',
      healthCertificateRequirement: normalizePolicyText(cert?.healthCertificate) || '未明确要求',
      remark: requirementRemark,
      interviewRemark,
      interviewSupplements,
    },
    interviewMeta: {
      method: normalizePolicyText(firstInterview?.firstInterviewWay) || null,
      address: normalizePolicyText(firstInterview?.interviewAddress) || null,
      demand: interviewDemand,
      timeHint: extractInterviewTimeHint(job),
    },
    highlights: {
      requirementHighlights,
      timingHighlights,
    },
  };
}
