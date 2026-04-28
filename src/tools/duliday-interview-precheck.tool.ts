import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { extractInterviewSupplementDefinitions } from '@sponge/sponge-job.util';
import {
  getAvailableSpongeEducations,
  getAvailableSpongeProvinces,
  SPONGE_COLLECTABLE_EDUCATION_MAPPING,
  SPONGE_GENDER_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING,
  SPONGE_OPERATE_TYPE_AI_IMPORT,
  SPONGE_OPERATE_TYPE_MAPPING,
  SPONGE_PROVINCE_MAPPING,
} from '@sponge/sponge.enums';
import { ToolBuilder } from '@shared-types/tool.types';
import { formatLocalDate, getTomorrowDate } from '@infra/utils/date.util';
import { stripNullish } from '@infra/utils/object.util';
import {
  API_BOOKING_OPTIONAL_PAYLOAD_FIELDS,
  API_BOOKING_REQUIRED_PAYLOAD_FIELDS,
  API_BOOKING_USER_OPTIONAL_FIELDS,
  API_BOOKING_USER_REQUIRED_FIELDS,
} from '@tools/duliday/job-booking.contract';
import {
  buildJobPolicyAnalysis,
  InterviewWindow,
  JobPolicyAnalysis,
  normalizePolicyText,
} from '@tools/duliday/job-policy-parser';
import {
  compareTime,
  getShanghaiWeekday,
  isDateOnlyWindow,
  normalizeHm,
  resolveBookingDeadlineDateTime,
  shiftDate,
} from '@tools/duliday/interview-window.util';
import {
  classifySupplementLabel,
  SupplementClassification,
} from '@tools/duliday/supplement-label-classifier';

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
  '面试时间',
  '学历',
  '健康证情况',
  '健康证类型',
  '身份',
  '户籍省份',
  '身高',
  '体重',
  '简历附件',
  '过往公司+岗位+年限',
  '应聘门店',
  '应聘岗位',
];

const TEMPLATE_CORE_FIELDS = ['姓名', '联系电话', '性别', '年龄', '面试时间', '应聘门店'];

const FIELD_LABELS: Record<string, string> = {
  联系电话: '联系方式',
  健康证情况: '健康证',
  户籍省份: '籍贯/户籍',
  简历附件: '简历',
};

const GENDER_ENUM_HINTS = Object.values(SPONGE_GENDER_MAPPING);

/**
 * 健康证首次询问时只暴露"有 / 无"两个选项给模型，让模型以最自然的方式问候选人。
 *
 * 业务背景：badcase `ub4vrq3v` —— "无但接受办理健康证" 等中间态选项会让候选人困惑，
 * 且现实中拒办的候选人通常不会来报名，默认按"无但接受办理健康证"收敛即可；只有候选人
 * 主动说"不接受办理"时才标记为"无且不接受办理健康证"。
 *
 * 枚举的完整三值（有 / 无但接受办理 / 无且不接受办理）仍保留在 SPONGE_HEALTH_CERTIFICATE_MAPPING
 * 用于 API 提交，不在此处展示。
 */
const HEALTH_CERT_ENUM_HINTS = ['有', '无'];

const HEALTH_CERT_TYPE_ENUM_HINTS = Object.values(SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING);

const SHORT_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const COLLECTION_RESISTANCE_PATTERNS = [
  { label: '这么多信息', pattern: /这么多(信息|资料|内容|东西|问题)/ },
  { label: '问/填这么多', pattern: /(问|填|提供|发|写).{0,4}这么多/ },
  { label: '太麻烦', pattern: /(太|好)?麻烦(了)?/ },
  { label: '不想填', pattern: /不想(填|提供|发|写)/ },
  { label: '不填了', pattern: /不(填|发|给)了/ },
  { label: '懒得填', pattern: /懒得(填|发|写)/ },
  { label: '烦死了', pattern: /烦死了|烦得很/ },
  { label: '滚犊子', pattern: /滚犊子|滚蛋/ },
] as const;

function normalizeChecklistField(field: string | null | undefined): string {
  const normalized = normalizePolicyText(field);
  if (!normalized) return '';

  if (['联系电话', '联系方式', '电话'].includes(normalized)) return '联系电话';
  if (normalized === '健康证' || normalized === '健康证情况' || normalized === '有无健康证') {
    return '健康证情况';
  }
  if (normalized === '籍贯' || normalized === '户籍' || normalized === '户籍省份') {
    return '户籍省份';
  }
  if (normalized === '身份' || normalized === '是否学生') return '身份';
  if (normalized === '简历' || normalized === '简历附件') return '简历附件';
  if (normalized === '过往公司+岗位+年限' || /工作经历|工作经验|过往公司/.test(normalized)) {
    return '过往公司+岗位+年限';
  }
  if (normalized === '面试日期') return '面试时间';

  return normalized;
}

function canonicalizeChecklistFields(fields: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    const canonical = normalizeChecklistField(field);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }

  return result;
}

function isUnrestrictedGenderRequirement(value: string | null | undefined): boolean {
  const normalized = normalizePolicyText(value).replace(/\s+/g, '');
  if (!normalized || normalized === '不限') return true;
  return /男.*女|女.*男/.test(normalized);
}

function formatConstraintText(value: string | null | undefined): string | null {
  const normalized = normalizePolicyText(value);
  if (!normalized) return null;
  return normalized.replace(/[\\/｜|]+/g, '、');
}

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

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeGenderValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  const hasMale = /男/.test(text);
  const hasStandaloneMale = /(^|[^女])男/.test(text);
  const hasFemale = /女/.test(text);
  if (hasMale && hasFemale) return null;
  if (hasStandaloneMale) return '男';
  if (hasFemale) return '女';
  return text;
}

function normalizeHealthCertificateValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  if (/^有$|有健康证/.test(text)) return '有';
  // 显式拒办优先识别，避免被下方"无但接受办理"模式误吞
  if (/无且不接受办理健康证|不办健康证|不接受办健康证|不接受办理/.test(text)) {
    return '无且不接受办理健康证';
  }
  if (/无但接受办理健康证|可以办健康证|可办健康证|接受办健康证|接受办理/.test(text)) {
    return '无但接受办理健康证';
  }
  // 候选人直接答"无/没有"等，按两步问法默认视为"无但接受办理健康证"
  // （现实中拒办的候选人通常不会来报名，业务侧已达成共识；后续若追加拒办信号会覆盖）。
  if (/^无$|没健康证|没有健康证|无健康证/.test(text)) return '无但接受办理健康证';
  return text;
}

function normalizeEducationValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  const supported = getAvailableSpongeEducations();
  if (supported.includes(text)) return text;
  return text;
}

function normalizeIdentityText(value: boolean | null | undefined): string | null {
  if (value == null) return null;
  return value ? '学生' : '社会人士';
}

/**
 * 当已知年龄 ≥ 25 时，默认候选人为社会人士，不再询问"是否学生"。
 *
 * 业务背景：badcase `2j20ew2z` —— 候选人 30 岁还被问"是不是学生"。
 * 25 岁是保守分界（硕士毕业通常 24~25 岁），避免误判个别超龄学生。
 *
 * 返回 null 表示无法判定（候选人自报/档案里显式 is_student 仍以原始值为准）。
 */
function inferIdentityFromAge(ageText: string | null | undefined): string | null {
  if (!ageText) return null;
  const match = ageText.match(/\d+/);
  if (!match) return null;
  const age = parseInt(match[0], 10);
  if (!Number.isFinite(age)) return null;
  if (age >= 25) return '社会人士';
  return null;
}

function normalizeTextValue(value: unknown): string | null {
  return typeof value === 'string' ? normalizePolicyText(value) || null : null;
}

function normalizeNumberText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return normalizePolicyText(value) || null;
  return null;
}

function normalizeArrayText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => normalizeTextValue(item)).filter(Boolean);
  return items.length > 0 ? items.join('、') : null;
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
    household_register_province?: string | null;
    height?: string | number | null;
    weight?: string | number | null;
    upload_resume?: string | null;
    health_certificate_types?: string[] | null;
    experience?: string | null;
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
    household_register_province?: string | null;
    height?: string | number | null;
    weight?: string | number | null;
    upload_resume?: string | null;
    health_certificate_types?: string[] | null;
    experience?: string | null;
  } | null;
  storeName?: string | null;
  jobName?: string | null;
}): Record<string, string> {
  const info = params.sessionInterviewInfo;
  const profile = params.contextProfile;
  const householdRegisterProvince =
    normalizePolicyText(info?.household_register_province) ||
    normalizePolicyText(profile?.household_register_province) ||
    null;
  const ageText = normalizePolicyText(info?.age) || normalizePolicyText(profile?.age) || null;
  const identityLabel =
    normalizeIdentityText(info?.is_student) ||
    normalizeIdentityText(profile?.is_student) ||
    inferIdentityFromAge(ageText);

  const map: Record<string, string | null> = {
    姓名: normalizePolicyText(info?.name) || normalizePolicyText(profile?.name),
    联系电话: normalizePolicyText(info?.phone) || normalizePolicyText(profile?.phone),
    性别: normalizeGenderValue(info?.gender) || normalizeGenderValue(profile?.gender),
    年龄: ageText,
    面试时间: normalizePolicyText(info?.interview_time),
    学历: normalizeEducationValue(info?.education) || normalizeEducationValue(profile?.education),
    健康证情况:
      normalizeHealthCertificateValue(info?.has_health_certificate) ||
      normalizeHealthCertificateValue(profile?.has_health_certificate),
    健康证类型:
      normalizeArrayText(info?.health_certificate_types) ||
      normalizeArrayText(profile?.health_certificate_types),
    身份: identityLabel,
    户籍省份: householdRegisterProvince,
    身高: normalizeNumberText(info?.height) || normalizeNumberText(profile?.height),
    体重: normalizeNumberText(info?.weight) || normalizeNumberText(profile?.weight),
    简历附件: normalizeTextValue(info?.upload_resume) || normalizeTextValue(profile?.upload_resume),
    '过往公司+岗位+年限':
      normalizeTextValue(info?.experience) || normalizeTextValue(profile?.experience),
    应聘门店:
      normalizePolicyText(params.storeName) || normalizePolicyText(info?.applied_store) || null,
    应聘岗位:
      normalizePolicyText(params.jobName) || normalizePolicyText(info?.applied_position) || null,
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
}): {
  requiredFields: string[];
  displayOrder: string[];
  missingFields: string[];
  templateText: string;
} {
  const requiredFields = canonicalizeChecklistFields(params.requiredFields);
  const knownOptionalFields = Object.keys(params.knownFieldMap).filter(
    (field) =>
      !requiredFields.includes(field) &&
      (API_BOOKING_USER_OPTIONAL_FIELDS as readonly string[]).includes(field),
  );
  // TEMPLATE_CORE_FIELDS 是收资模板必要骨架（姓名/电话/性别/年龄/面试时间/应聘门店）。
  // 即使岗位 API 没把这些字段写进 requiredFields，也必须强制纳入展示——
  // badcase #2 `recvhXziDt4jps`：API 漏了"姓名"，模板就把姓名整行删掉了，
  // 候选人按模板填一堆资料没填名字，bot 才补问。
  const orderedFields = orderFields([
    ...TEMPLATE_CORE_FIELDS,
    ...requiredFields,
    ...knownOptionalFields,
  ]);
  const coreFields = TEMPLATE_CORE_FIELDS.filter((field) => orderedFields.includes(field));
  const dynamicFields = orderedFields.filter((field) => !TEMPLATE_CORE_FIELDS.includes(field));
  const displayOrder = [...coreFields, ...dynamicFields];

  const missingFields = displayOrder.filter((field) => !params.knownFieldMap[field]);

  const lines = [
    '面试要求：先将以下资料补充下发给我，我来帮你约面试',
    ...displayOrder.map((field) => {
      const value = params.knownFieldMap[field] ?? '';
      return `${formatTemplateFieldLabel(field)}：${value}`;
    }),
  ];

  return {
    requiredFields,
    displayOrder,
    missingFields,
    templateText: lines.join('\n'),
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((item) => extractMessageText(item))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }

  return '';
}

function getRecentUserMessages(messages: unknown[], limit = 3): string[] {
  const texts = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const record = message as Record<string, unknown>;
      if (record.role !== 'user') return null;
      const text = normalizePolicyText(extractMessageText(record.content));
      return text || null;
    })
    .filter((text): text is string => Boolean(text));

  return texts.slice(-limit);
}

function detectCollectionResistance(messages: unknown[]): {
  detected: boolean;
  matchedSignals: string[];
  latestUserMessage: string | null;
} {
  const recentUserMessages = getRecentUserMessages(messages);
  const latestUserMessage = recentUserMessages[recentUserMessages.length - 1] ?? null;

  if (!latestUserMessage) {
    return {
      detected: false,
      matchedSignals: [],
      latestUserMessage: null,
    };
  }

  const matchedSignals = dedupeStrings(
    recentUserMessages.flatMap((message) =>
      COLLECTION_RESISTANCE_PATTERNS.filter(({ pattern }) => pattern.test(message)).map(
        ({ label }) => label,
      ),
    ),
  );

  return {
    detected: matchedSignals.length > 0,
    matchedSignals,
    latestUserMessage,
  };
}

function buildCollectionStrategy(params: {
  missingFields: string[];
  resistanceSignals: string[];
}): {
  candidateResistanceDetected: boolean;
  recommendedMode: 'full_template' | 'progressive';
  reason: string;
  starterFields: string[];
  remainingFields: string[];
} {
  const orderedMissingFields = orderFields(params.missingFields);
  const coreMissingFields = orderFields(
    orderedMissingFields.filter((field) =>
      (API_BOOKING_USER_REQUIRED_FIELDS as readonly string[]).includes(field),
    ),
  );
  const starterFields =
    coreMissingFields.length > 0
      ? coreMissingFields
      : orderedMissingFields.slice(0, Math.min(2, orderedMissingFields.length));
  const remainingFields = orderedMissingFields.filter((field) => !starterFields.includes(field));
  const candidateResistanceDetected = params.resistanceSignals.length > 0;

  return {
    candidateResistanceDetected,
    recommendedMode: candidateResistanceDetected ? 'progressive' : 'full_template',
    reason: candidateResistanceDetected
      ? `候选人当前对收资有抗拒或不耐烦信号（${params.resistanceSignals.join('、')}），先共情解释，再从 starterFields 开始逐步收集`
      : '候选人当前没有明显收资阻力，正常场景可直接参考 templateText 一次性收集当前岗位需要的信息',
    starterFields,
    remainingFields,
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

function buildBookableSlots(params: {
  windows: InterviewWindow[];
  requestedDate?: string | null;
  horizonDays?: number;
  maxOptions?: number;
}): Array<Record<string, unknown>> {
  const { windows, requestedDate = null, horizonDays = 7, maxOptions = 10 } = params;
  if (windows.length === 0) return [];

  const now = new Date();
  const today = formatLocalDate(now);
  const nowTime = formatShanghaiTime(now);
  const nowDateTime = `${today} ${nowTime}`;
  const dates = new Set<string>();

  for (let i = 0; i < horizonDays; i += 1) {
    dates.add(shiftDate(today, i));
  }
  if (requestedDate) dates.add(requestedDate);

  const slots: Array<Record<string, unknown> & { date: string; startTime: string }> = [];
  const seen = new Set<string>();

  for (const date of dates) {
    const weekday = getShanghaiWeekday(date);

    for (const window of windows) {
      if (window.date && window.date !== date) continue;
      if (!window.date && window.weekday && window.weekday !== weekday) continue;
      if (!window.date && !window.weekday) continue;

      const registrationDeadline = resolveBookingDeadlineDateTime(date, window);
      if (registrationDeadline && nowDateTime.localeCompare(registrationDeadline) > 0) continue;

      const key = `${date}|${window.startTime}|${window.endTime}|${registrationDeadline ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const weekdayShort = weekday.replace('每周', '周');
      const dateOnly = isDateOnlyWindow(window);
      const normalizedStart = normalizeHm(window.startTime);
      const base = {
        date,
        weekday: weekdayShort,
        startTime: window.startTime,
        endTime: window.endTime,
        label: `${date} ${weekdayShort} ${window.startTime}-${window.endTime}`,
        registrationDeadline,
      };

      slots.push(
        dateOnly
          ? {
              ...base,
              dateOnly: true,
              bookingAllowed: false,
              requiresManualConfirmation: true,
              reason:
                '该面试窗口只标注日期，没有明确几点面试；不要自动调用预约工具，先让同事确认具体提交时间。',
            }
          : !normalizedStart
            ? {
                ...base,
                dateOnly: false,
                bookingAllowed: false,
                requiresManualConfirmation: true,
                reason:
                  '该面试窗口缺少可识别的具体开始时间；不要自动调用预约工具，先让同事确认具体提交时间。',
              }
            : {
                ...base,
                dateOnly: false,
                bookingAllowed: true,
                interviewTime: `${date} ${normalizedStart}:00`,
              },
      );
    }
  }

  slots.sort((a, b) =>
    a.date === b.date ? compareTime(a.startTime, b.startTime) : a.date.localeCompare(b.date),
  );

  if (requestedDate) {
    const requestedSlots = slots.filter((slot) => slot.date === requestedDate);
    const otherSlots = slots
      .filter((slot) => slot.date !== requestedDate)
      .slice(0, Math.max(0, maxOptions - requestedSlots.length));
    return [...requestedSlots, ...otherSlots];
  }

  return slots.slice(0, maxOptions);
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
  const getNonSupplementSignal = (field: string) =>
    analysis.fieldGuidance.fieldSignals.find(
      (signal) => signal.field === field && signal.sourceField !== 'interview_supplement',
    );

  if (!isUnrestrictedGenderRequirement(req.genderRequirement)) {
    result.gender = formatConstraintText(req.genderRequirement) ?? req.genderRequirement;
  }
  if (req.ageRequirement && req.ageRequirement !== '不限') {
    result.age = formatConstraintText(req.ageRequirement) ?? req.ageRequirement;
  }
  if (req.educationRequirement && req.educationRequirement !== '不限') {
    result.education = formatConstraintText(req.educationRequirement) ?? req.educationRequirement;
  }
  if (req.healthCertificateRequirement && req.healthCertificateRequirement !== '未明确要求') {
    result.healthCertificate =
      formatConstraintText(req.healthCertificateRequirement) ?? req.healthCertificateRequirement;
  }

  const studentSignal = getNonSupplementSignal('是否学生');
  if (studentSignal?.evidence) {
    result.isStudent = formatConstraintText(studentSignal.evidence) ?? studentSignal.evidence;
  }

  const experienceSignal = getNonSupplementSignal('过往公司+岗位+年限');
  if (experienceSignal?.evidence) {
    result.experience =
      formatConstraintText(experienceSignal.evidence) ?? experienceSignal.evidence;
  }

  const householdSignal = getNonSupplementSignal('户籍省份');
  if (householdSignal?.evidence) {
    result.householdRegisterProvince =
      formatConstraintText(householdSignal.evidence) ?? householdSignal.evidence;
  }

  const heightSignal = getNonSupplementSignal('身高');
  if (heightSignal?.evidence) {
    result.height = formatConstraintText(heightSignal.evidence) ?? heightSignal.evidence;
  }

  const weightSignal = getNonSupplementSignal('体重');
  if (weightSignal?.evidence) {
    result.weight = formatConstraintText(weightSignal.evidence) ?? weightSignal.evidence;
  }

  const resumeSignal = getNonSupplementSignal('简历附件');
  if (resumeSignal?.evidence) {
    result.resume = formatConstraintText(resumeSignal.evidence) ?? resumeSignal.evidence;
  }

  if (req.remark) result.remark = formatConstraintText(req.remark) ?? req.remark;
  if (req.interviewRemark) {
    result.interviewRemark = formatConstraintText(req.interviewRemark) ?? req.interviewRemark;
  }

  return result;
}

/**
 * 只返回 missingFields 里涉及字段的枚举提示，避免 LLM 已知时还要看全量枚举。
 */
function buildEnumHintsForMissing(missingFields: string[]): Record<string, string[]> {
  const hints: Record<string, string[]> = {};
  if (missingFields.includes('性别')) hints.gender = [...GENDER_ENUM_HINTS];
  if (missingFields.includes('健康证情况')) hints.healthCertificate = [...HEALTH_CERT_ENUM_HINTS];
  if (missingFields.includes('健康证类型')) {
    hints.healthCertificateTypes = [...HEALTH_CERT_TYPE_ENUM_HINTS];
  }
  if (missingFields.includes('学历')) hints.education = getAvailableSpongeEducations();
  if (missingFields.some((field) => ['籍贯', '户籍', '户籍省份'].includes(field))) {
    hints.householdRegisterProvince = getAvailableSpongeProvinces();
  }
  if (missingFields.includes('身份')) {
    hints.identity = ['学生', '社会人士'];
  }
  return hints;
}

function buildApiPayloadGuide(
  jobId: number,
  customerLabelDefinitions: Array<{ labelId: number; labelName: string; name: string }>,
) {
  return {
    requiredFields: [...API_BOOKING_REQUIRED_PAYLOAD_FIELDS],
    optionalFields: [...API_BOOKING_OPTIONAL_PAYLOAD_FIELDS],
    fixedValues: {
      jobId,
      operateType: SPONGE_OPERATE_TYPE_AI_IMPORT,
    },
    customerLabelDefinitions,
    enumMappings: {
      genderId: { ...SPONGE_GENDER_MAPPING },
      hasHealthCertificate: { ...SPONGE_HEALTH_CERTIFICATE_MAPPING },
      healthCertificateTypes: { ...SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING },
      educationId: { ...SPONGE_COLLECTABLE_EDUCATION_MAPPING },
      householdRegisterProvinceId: { ...SPONGE_PROVINCE_MAPPING },
      operateType: {
        [SPONGE_OPERATE_TYPE_AI_IMPORT]: SPONGE_OPERATE_TYPE_MAPPING[SPONGE_OPERATE_TYPE_AI_IMPORT],
      },
    },
  };
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
      description: `面试前置校验。本工具负责解释岗位规则、返回筛选条件和收资策略，**不负责真正提交预约**（真正提交用 duliday_interview_booking）。

## 何时调用
- 候选人问"今天可以吗"、"什么时候可以面试"、"要准备什么资料"、"还需要我提供什么信息"时优先调用
- 回答"今天可以吗/哪天能面/要补哪些资料"前，先看此工具结果；不要只根据 duliday_job_list 的摘要或自己理解直接回答

## 参数
- jobId：岗位 ID（必填）
- requestedDate：**仅当**候选人明确说出想约的具体日期时才传入（如 today / 明天 / 下周三 / YYYY-MM-DD）。候选人只是泛泛询问时不要传

## 返回字段
- interview.scheduleRule：岗位的面试周期规则，例如"周一至周五 13:30-16:30，当天 12:00 前报名"。用来回答"还有别的时间吗/下周能约吗"这类开放问题
- interview.upcomingTimeOptions：未来 7 天实际可约时段的示例 label 数组（已自动过滤报名截止已过的时段）。用来回答"给我几个时间选选"
- interview.bookableSlots：结构化可约时段。只有 bookingAllowed=true 且带 interviewTime 的 slot 才能进入 duliday_interview_booking；bookingAllowed=false / dateOnly=true 表示只确定日期、不确定具体面试时间，必须先人工确认，严禁拿 registrationDeadline 当 interviewTime
- interview.requestedDate：只有在传入 requestedDate 时才有；包含 status（available / unavailable / needs_confirmation）和 reason
- screeningCriteria：岗位硬性筛选条件（性别/年龄/学历/健康证/是否学生等），**用来筛人**——候选人不符合时直接说明，不要继续往下引导
- screeningChecks：岗位后台把约束语义直接配在 supplement label 里的那一类筛选题（例如 "是否学生（不要学生）"、"专业（非新媒、食品）"、"周四六日都能上班吗"）。**用来筛人**——必须先独立向候选人核对，候选人答案命中 failSignals 就停止收资、走婉拒/拉群，不得继续 booking
- bookingChecklist.missingFields：预约还缺哪些字段（已剔除 screeningChecks 列出的筛选型 label）
- bookingChecklist.templateText：正常收资场景下可直接参考的话术模板，已根据会话上下文预填已知字段
- bookingChecklist.enumHints：只包含 missingFields 涉及字段的合法枚举
- bookingChecklist.collectionStrategy：当前更适合一次性收资还是渐进式收资；若候选人已表现出抗拒，会返回 starterFields 供你先降负担推进
- apiPayloadGuide：最新 supplier/entryUser 契约入参指引

## 硬规则
- 面试时段是**周期性规则**，不是"固定几个名额"。即使 upcomingTimeOptions 只列出几条，也要结合 scheduleRule 理解完整规则，不得说"只有这几个时间可以约"
- "报名截止/registrationDeadline" 只表示最晚提交预约的时间，**绝不是面试时间**；严禁把报名截止时间传给 duliday_interview_booking
- 若 bookableSlots 中目标日期的 slot 为 dateOnly=true 或 bookingAllowed=false，只能告诉候选人"日期可以/线上面试但具体时间需确认"，不要调用 duliday_interview_booking
- 若 interview.requestedDate.status 为 unavailable，必须直接说明原因，不得继续引导候选人填写资料假装可以预约
- 若 interview.requestedDate.status 为 needs_confirmation，先表述"我先帮你确认下今天还能不能约"，不要直接承诺可以，也不要输出生硬的规则解释句
- 候选人只是询问规则或资料时，先解释规则；不要跳过校验直接进入 duliday_interview_booking
- 当 nextAction = collect_fields 时，bookingChecklist.templateText 只是默认模板，不是必须逐字复读的指令；正常收资场景优先参考它一次性收集资料，但不要为了守模板而忽略候选人当前情绪
- 若候选人当轮出现抗拒、不耐烦、拒绝填写、嫌麻烦或辱骂，立即暂停模板化收资；先共情并解释用途，再按 bookingChecklist.collectionStrategy 里的 starterFields 降负担推进，不要继续追整张字段清单
- 只有在候选人恢复配合、且没有明显情绪阻力时，才恢复完整字段清单或继续进入预约
- 若返回了 screeningChecks，在把 templateText 发给候选人之前，**必须**用自然话术核对每一条的通过条件；候选人明确表达命中 failSignals 的答案（如"食品类"、"不一定"）时，立即停止收资、婉拒并走 invite_to_group 或 request_handoff`,
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
          const customerLabelDefinitions = extractInterviewSupplementDefinitions(job);
          // 把岗位后台配的每个 supplement label 按语义分成"收集型"和"筛选型"。
          // 筛选型（labelName 自带括号黑名单或反问式）不应进入收集模板，否则 Agent
          // 会把筛选条件错当成待填字段问候选人 —— badcase 69e9bba2536c9654026522da。
          const labelClassifications = customerLabelDefinitions.map((definition) => ({
            definition,
            classification: classifySupplementLabel(definition.labelName),
          }));
          const collectLabelNames = labelClassifications
            .filter((lc) => lc.classification.type === 'collect')
            .map((lc) => lc.definition.name);
          const screeningChecks = labelClassifications
            .filter(
              (
                lc,
              ): lc is {
                definition: (typeof labelClassifications)[number]['definition'];
                classification: Extract<SupplementClassification, { type: 'screening' }>;
              } => lc.classification.type === 'screening',
            )
            .map((lc) => ({
              labelName: lc.definition.labelName,
              labelId: lc.definition.labelId,
              mode: lc.classification.mode,
              failSignals: [...lc.classification.failSignals],
            }));

          const knownFieldMap = buildKnownFieldMap({
            contextProfile: context.profile ?? null,
            sessionInterviewInfo: context.sessionFacts?.interview_info ?? null,
            storeName,
            jobName,
          });

          const requiredFields = [
            ...API_BOOKING_USER_REQUIRED_FIELDS,
            ...analysis.fieldGuidance.screeningFields,
            ...collectLabelNames,
          ];
          const checklist = buildChecklistTemplate({
            requiredFields,
            knownFieldMap,
          });

          const upcomingTimeOptions = buildUpcomingTimeOptions(windows);
          const bookableSlots = buildBookableSlots({
            windows,
            requestedDate: normalizedDate.date,
          });
          const scheduleRule = buildScheduleRule(windows);
          const screeningCriteria = buildScreeningCriteria(analysis);
          const enumHints = buildEnumHintsForMissing(checklist.missingFields);
          const collectionResistance = detectCollectionResistance(context.messages);
          const collectionStrategy =
            checklist.missingFields.length > 0
              ? buildCollectionStrategy({
                  missingFields: checklist.missingFields,
                  resistanceSignals: collectionResistance.matchedSignals,
                })
              : null;

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
              collectionResistanceDetected: collectionResistance.detected,
              collectionResistanceSignals: collectionResistance.matchedSignals,
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
              bookableSlots,
              requestedDate: requestedDateCheck
                ? {
                    value: normalizedDate.date,
                    status: requestedDateCheck.status,
                    reason: requestedDateCheck.reason,
                  }
                : null,
            },
            screeningCriteria,
            // 筛选型 supplement label 单独出口：Agent 必须先独立向候选人核对，
            // 候选人答案命中任一 failSignal 就停止收资；对应字段不在 templateText
            // 里（否则会被错当成需要填写的字段）。
            screeningChecks: screeningChecks.length > 0 ? screeningChecks : undefined,
            bookingChecklist: {
              requiredFields: checklist.requiredFields,
              displayOrder: checklist.displayOrder,
              missingFields: checklist.missingFields,
              templateText: checklist.templateText,
              enumHints,
              collectionStrategy: collectionStrategy
                ? {
                    ...collectionStrategy,
                    latestUserMessage: collectionResistance.detected
                      ? collectionResistance.latestUserMessage
                      : undefined,
                    matchedSignals: collectionResistance.detected
                      ? collectionResistance.matchedSignals
                      : undefined,
                  }
                : undefined,
              customerLabelDefinitions,
              apiPayloadGuide: buildApiPayloadGuide(jobId, customerLabelDefinitions),
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
