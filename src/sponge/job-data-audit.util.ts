import { asRecord, asRecordArray, type UnknownRecord } from '@infra/utils/object.util';

/**
 * 岗位数据录入体检（PRD R4「数据体检告警」/ R8）。纯函数，零副作用，供每日 cron 与单测复用。
 *
 * 四类问题（证据见 docs/todo/job-data-gap-analysis-2026-09-20.md 第五节）：
 * 1. 福利备注 / 薪资备注写了阶梯薪资（满 N 小时、月工时区间、阶梯/分层字样），结构化阶梯字段却为空；
 * 2. 结构化节假日薪资与备注里能解析出数字的节假日薪资矛盾；
 * 3. 综合薪资上下限比例异常（上限/下限 > 3，或下限 > 上限，疑似多打一个零）；
 * 4. 在招岗位发薪日为空。
 *
 * 只输出岗位 ID、品牌与数值/短片段，不输出门店联系人；告警文案由调用方拼装。
 */
export type JobDataIssueKind =
  | 'stair_text_without_structure'
  | 'holiday_salary_conflict'
  | 'comprehensive_salary_ratio'
  | 'payday_missing';

export interface JobDataIssue {
  jobId: number | null;
  brandName: string | null;
  kind: JobDataIssueKind;
  /** 面向运营的一句话：只含数值与 ≤40 字的命中片段。 */
  detail: string;
}

export const JOB_DATA_ISSUE_LABELS: Record<JobDataIssueKind, string> = {
  stair_text_without_structure: '备注有阶梯而结构化标无',
  holiday_salary_conflict: '节假日薪资两处矛盾',
  comprehensive_salary_ratio: '综合薪资上下限比例异常',
  payday_missing: '发薪日为空',
};

/** 综合薪资上限/下限超过该倍数视为异常（疑似多打一个零）。 */
export const COMPREHENSIVE_SALARY_MAX_RATIO = 3;

const STAIR_TEXT_PATTERNS: readonly RegExp[] = [
  /阶梯|分层/u,
  /满\s*\d+(?:\.\d+)?\s*(?:个?小时|h|工时|单|天|日|个?月)/iu,
  /工时\s*[<>≤≥＜＞=]*\s*\d+(?:\.\d+)?/u,
  /\d+(?:\.\d+)?\s*(?:小时|h|工时)\s*(?:及?以上|以下|以内)/iu,
];

const HOLIDAY_KEYWORD = '(?:法定|节假日|节日|假日)';
/** 备注里「法定 3 倍」「节假日 55.5 元」：关键字后 8 字内出现带单位的数字。 */
const HOLIDAY_TEXT_WITH_UNIT = new RegExp(
  `${HOLIDAY_KEYWORD}[^\\d\\n]{0,8}?(\\d+(?:\\.\\d+)?)\\s*(倍|元)`,
  'gu',
);
/** 备注里「法定单价55.5」「节假日时薪：30」：价格词后直接跟数字（无单位按元计）。 */
const HOLIDAY_TEXT_PRICE_WORD = new RegExp(
  `${HOLIDAY_KEYWORD}[^\\d\\n]{0,6}?(?:单价|时薪|薪资|工资|薪)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`,
  'gu',
);
/** 结构化节假日薪资自带的说明字段：本身就是节假日语境，只认带单位的数字。 */
const HOLIDAY_DESC_WITH_UNIT = /(\d+(?:\.\d+)?)\s*(倍|元)/gu;

const SNIPPET_MAX = 40;

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function snippet(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > SNIPPET_MAX ? `${compact.slice(0, SNIPPET_MAX)}…` : compact;
}

function scenariosOf(job: UnknownRecord): UnknownRecord[] {
  return asRecordArray(asRecord(job.jobSalary)?.salaryScenarioList);
}

function hasStructuredStair(scenarios: UnknownRecord[]): boolean {
  return scenarios.some((scenario) => {
    const flag = readText(scenario.hasStairSalary);
    return (
      (flag !== null && flag.includes('有')) || asRecordArray(scenario.stairSalaries).length > 0
    );
  });
}

/** ① 阶梯只写在自由文本里，结构化阶梯字段为空。 */
function detectStairTextWithoutStructure(job: UnknownRecord): string | null {
  const scenarios = scenariosOf(job);
  if (hasStructuredStair(scenarios)) return null;

  const texts: Array<{ label: string; text: string | null }> = [
    { label: '福利备注', text: readText(asRecord(job.welfare)?.memo) },
  ];
  for (const scenario of scenarios) {
    const other = asRecord(scenario.otherSalary);
    texts.push(
      { label: '奖金说明', text: readText(scenario.bonusDesc) },
      { label: '提成说明', text: readText(other?.commission) },
      { label: '绩效说明', text: readText(other?.performance) },
    );
  }
  for (const { label, text } of texts) {
    if (!text) continue;
    for (const pattern of STAIR_TEXT_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        return `${label}出现「${snippet(match[0])}」，但结构化阶梯字段为空（hasStairSalary/stairSalaries）`;
      }
    }
  }
  return null;
}

interface HolidayClaim {
  amount?: number;
  multiple?: number;
  source: string;
}

function collectHolidayClaims(text: string | null, mode: 'memo' | 'desc'): HolidayClaim[] {
  if (!text) return [];
  const claims: HolidayClaim[] = [];
  if (mode === 'desc') {
    for (const match of text.matchAll(HOLIDAY_DESC_WITH_UNIT)) {
      const value = Number(match[1]);
      claims.push(
        match[2] === '倍'
          ? { multiple: value, source: match[0] }
          : { amount: value, source: match[0] },
      );
    }
    return claims;
  }
  for (const match of text.matchAll(HOLIDAY_TEXT_WITH_UNIT)) {
    const value = Number(match[1]);
    claims.push(
      match[2] === '倍'
        ? { multiple: value, source: match[0] }
        : { amount: value, source: match[0] },
    );
  }
  for (const match of text.matchAll(HOLIDAY_TEXT_PRICE_WORD)) {
    claims.push({ amount: Number(match[1]), source: match[0] });
  }
  return claims;
}

function describeStructuredHoliday(holiday: UnknownRecord | null): string {
  if (!holiday) return '未配置';
  const type = readText(holiday.holidaySalaryType) ?? '未配置';
  const multiple = toFiniteNumber(holiday.holidaySalaryMultiple);
  const fixed = toFiniteNumber(holiday.holidayFixedSalary);
  const unit = readText(holiday.holidayFixedSalaryUnit) ?? '';
  if (multiple !== null) return `${type} ${multiple}倍`;
  if (fixed !== null) return `${type} ${fixed}${unit}`;
  return type;
}

/** ② 结构化节假日薪资与备注文本里的数字矛盾。 */
function detectHolidaySalaryConflict(job: UnknownRecord): string | null {
  const memo = readText(asRecord(job.welfare)?.memo);
  for (const scenario of scenariosOf(job)) {
    const holiday = asRecord(scenario.holidaySalary);
    const type = readText(holiday?.holidaySalaryType) ?? '';
    const multiple = toFiniteNumber(holiday?.holidaySalaryMultiple);
    const fixed = toFiniteNumber(holiday?.holidayFixedSalary);
    const claims = [
      ...collectHolidayClaims(readText(holiday?.holidaySalaryDesc), 'desc'),
      ...collectHolidayClaims(memo, 'memo'),
    ];
    for (const claim of claims) {
      const consistent =
        claim.multiple !== undefined
          ? type.includes('多倍') && multiple === claim.multiple
          : type.includes('固定') && fixed === claim.amount;
      if (!consistent) {
        return `结构化节假日薪资「${describeStructuredHoliday(holiday)}」，备注却写「${snippet(claim.source)}」`;
      }
    }
  }
  return null;
}

/** ③ 综合薪资上下限比例异常。 */
function detectComprehensiveSalaryRatio(job: UnknownRecord): string | null {
  for (const scenario of scenariosOf(job)) {
    const comp = asRecord(scenario.comprehensiveSalary);
    const min = toFiniteNumber(comp?.minComprehensiveSalary);
    const max = toFiniteNumber(comp?.maxComprehensiveSalary);
    if (min === null || max === null) continue;
    const unit = readText(comp?.comprehensiveSalaryUnit) ?? '';
    if (min > max) return `综合薪资下限 ${min} 大于上限 ${max}${unit ? `（${unit}）` : ''}`;
    if (min > 0 && max / min > COMPREHENSIVE_SALARY_MAX_RATIO) {
      return `综合薪资 ${min}-${max}${unit ? ` ${unit}` : ''} 上限/下限=${(max / min).toFixed(1)}，超过 ${COMPREHENSIVE_SALARY_MAX_RATIO} 倍`;
    }
  }
  return null;
}

/** ④ 发薪日为空（调用方只传在招岗位）。 */
function detectPaydayMissing(job: UnknownRecord): string | null {
  const scenarios = scenariosOf(job);
  for (const [index, scenario] of scenarios.entries()) {
    if (readText(scenario.payday)) continue;
    const label = readText(scenario.salaryType) ?? `薪资方案${index + 1}`;
    const period = readText(scenario.salaryPeriod);
    return `${label}${period ? `（${period}）` : ''}发薪日 payday 为空`;
  }
  return null;
}

const DETECTORS: ReadonlyArray<{
  kind: JobDataIssueKind;
  detect: (job: UnknownRecord) => string | null;
}> = [
  { kind: 'stair_text_without_structure', detect: detectStairTextWithoutStructure },
  { kind: 'holiday_salary_conflict', detect: detectHolidaySalaryConflict },
  { kind: 'comprehensive_salary_ratio', detect: detectComprehensiveSalaryRatio },
  { kind: 'payday_missing', detect: detectPaydayMissing },
];

/** 体检单个岗位；非对象输入返回空数组。每类问题最多报一条。 */
export function auditJobData(jobInput: unknown): JobDataIssue[] {
  const job = asRecord(jobInput);
  if (!job) return [];
  const basicInfo = asRecord(job.basicInfo);
  const jobId = toFiniteNumber(basicInfo?.jobId);
  const brandName = readText(basicInfo?.brandName);
  const issues: JobDataIssue[] = [];
  for (const { kind, detect } of DETECTORS) {
    const detail = detect(job);
    if (detail) issues.push({ jobId, brandName, kind, detail });
  }
  return issues;
}

export function auditJobDataBatch(jobs: readonly unknown[]): JobDataIssue[] {
  return jobs.flatMap((job) => auditJobData(job));
}

export function countJobDataIssuesByKind(
  issues: readonly JobDataIssue[],
): Record<JobDataIssueKind, number> {
  const counts: Record<JobDataIssueKind, number> = {
    stair_text_without_structure: 0,
    holiday_salary_conflict: 0,
    comprehensive_salary_ratio: 0,
    payday_missing: 0,
  };
  for (const issue of issues) counts[issue.kind] += 1;
  return counts;
}

/** 告警正文：按问题类型分组，每行「jobId 品牌：明细」，超过 maxLines 行截断并注明。 */
export function formatJobDataAuditReport(issues: readonly JobDataIssue[], maxLines = 60): string {
  const lines: string[] = [];
  for (const kind of Object.keys(JOB_DATA_ISSUE_LABELS) as JobDataIssueKind[]) {
    const group = issues.filter((issue) => issue.kind === kind);
    if (group.length === 0) continue;
    lines.push(`【${JOB_DATA_ISSUE_LABELS[kind]}】${group.length} 条`);
    for (const issue of group) {
      lines.push(`- ${issue.jobId ?? '未知ID'} ${issue.brandName ?? ''}：${issue.detail}`.trim());
    }
  }
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), `…（共 ${lines.length} 行，已截断）`].join('\n');
}
