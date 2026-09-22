/**
 * 给 LLM 直接转述给候选人的岗位推荐卡片模板渲染层。
 *
 * 历史 badcase 簇 ④（推荐/收尾文案 LLM 自由作文）共 20 条待修，其中 11 条
 * 直接由"班次/薪资/地址缺失"造成：
 *  - 班次 5 条（qkiygu5s / uyhffxit / bxobhhmy / 45fkfivu / nndx2ctl）：
 *    Agent 推荐时漏说"每周出勤天数 + 班次时间"
 *  - 薪资 3 条（03n3gv35 / 6b0wknts / znabv7ph）：介绍薪资偷懒/不清楚/漏阶梯
 *  - 推荐缺地址 3 条（afdxytz0 / mgqlhyd1 / x189vplh）：岗位推荐没有门店名/地址
 *
 * 当前路径：Agent 自己从 raw job 拼装推荐句子 → 频繁漏字段。
 *
 * 本层路径：从 raw job 派生"固定结构的 candidate-facing 卡片"，Agent 推荐时
 * 直接照念 candidateCard 原文（可微调连接词，但禁止删除字段）。
 *
 * 设计原则：
 *  - 信息密度优先：1 个岗位 2-3 行覆盖关键事实（地址 / 班次 / 薪资 / 硬要求）
 *  - 薪资行按岗位类型定型（兼职阶梯 / 兼职无阶梯 / 全职），推荐时只给关键项，细节留给追问
 *  - 缺失字段优雅省略（不输出 "班次: undefined"）
 *  - 不输出"建议/可能/也许/大概"等软性措辞
 *  - 不进入决策——这一层只是把已派生事实拼装成候选人友好句子
 */

import { hasValue } from '@tools/job-list/helpers.util';
import {
  formatDistanceKm,
  type DistanceAnchorPrecision,
} from '@tools/job-list/distance-render.util';
import { normalizeStoreNameForAgent } from '@tools/job-list/sanitize.util';
import { resolveWeeklyWorkDays } from '@tools/job-list/schedule-semantic.util';
import {
  extractHardRequirements,
  type HardRequirements,
} from '@tools/job-list/hard-requirements.util';
import { buildJobPolicyAnalysis, sanitizeConstraintText } from '@tools/job-list/job-policy-parser';
import { sanitizeLaborFormForDisplay } from '@resolution/labor-form';
import type { JobBasicInfo, JobDetail } from '@sponge/sponge.types';

export interface CandidateCard {
  jobId: number | string;
  /** 单行精简版（"1. KFC 服务员 - 静安寺店 | 2.3km | 周一至五 11-15 ｜ 24-29元/时 ｜ 18-50 岁 需食品健康证"） */
  oneLine: string;
  /** 多行可读版（标题 + 班次 + 薪资 + 要求 三行格式） */
  multiLine: string;
}

const NON_POSITION_PATTERN =
  /^(日结|周结|月结|小时工|兼职|全职|临时工|短期工|长期工|社会兼职)[\+＋]?$|^(只招|目前只|仅招)/;

function resolvePositionName(bi: JobBasicInfo): string {
  const nick = typeof bi.jobNickName === 'string' ? bi.jobNickName.trim() : '';
  if (nick && !NON_POSITION_PATTERN.test(nick)) return nick;
  const cat = bi.jobCategoryName;
  if (typeof cat === 'string' && cat.includes('/')) {
    const last = cat.split('/').pop()?.trim();
    if (last) return last;
  }
  if (nick) return nick;
  return '岗位';
}

// ==================== 班次 ====================

/**
 * `buildShiftPart` 实际读取的最小 workTime 字段集。
 * 命名与外部 raw workTime 一致，作为该函数的自描述契约
 * （同 brand-stores.util 的 `BrandSummaryJobInput`）；raw 值仍靠 `hasValue` 逐字段兜底。
 */
interface ShiftWorkTimeInput {
  dayWorkTime?: {
    combinedArrangement?: unknown;
    fixedTime?: {
      goToWorkStartTime?: string;
      goOffWorkEndTime?: string;
      goOffWorkTimeType?: string;
      perDayMinWorkHours?: number | string;
    };
  } | null;
  weekAndMonthWorkTime?: {
    perWeekWorkDays?: number | string;
    perWeekRestDays?: number | string;
  } | null;
}

function buildShiftPart(workTime: unknown): string {
  if (!workTime) return '';
  const wt = workTime as ShiftWorkTimeInput;
  const parts: string[] = [];

  // 时间段：海绵2.0 优先取 dayWorkTime.combinedArrangement（固定/组合排班的多时段），
  // 灵活排班则取 fixedTime 的上下班区间。不做计算，直接展示。
  const day: NonNullable<ShiftWorkTimeInput['dayWorkTime']> = wt?.dayWorkTime ?? {};
  const combined: Array<{
    combinedArrangementStartTime?: string;
    combinedArrangementEndTime?: string;
  }> = Array.isArray(day.combinedArrangement) ? day.combinedArrangement : [];
  const ranges = combined
    .filter(
      (s) => hasValue(s?.combinedArrangementStartTime) && hasValue(s?.combinedArrangementEndTime),
    )
    .map((s) => `${s.combinedArrangementStartTime}-${s.combinedArrangementEndTime}`);
  const ft: NonNullable<NonNullable<ShiftWorkTimeInput['dayWorkTime']>['fixedTime']> =
    day.fixedTime ?? {};
  if (ranges.length === 0 && hasValue(ft.goToWorkStartTime) && hasValue(ft.goOffWorkEndTime)) {
    const nextDay = /次日/.test(String(ft.goOffWorkTimeType ?? '')) ? '次日' : '';
    ranges.push(`${ft.goToWorkStartTime}-${nextDay}${ft.goOffWorkEndTime}`);
  }
  if (ranges.length > 0) parts.push(ranges.join(' / '));

  // 每日最少工时（有则展示，不推断）
  const dayMin = ft.perDayMinWorkHours;
  if (hasValue(dayMin)) parts.push(`每日至少 ${dayMin} 小时`);

  // 每周天数
  const wm: NonNullable<ShiftWorkTimeInput['weekAndMonthWorkTime']> =
    wt?.weekAndMonthWorkTime ?? {};
  // 做一休一等循环班型的 perWeekWorkDays 不是周频，直出会变成"每周 1 天"
  const weekly = resolveWeeklyWorkDays(wm);
  if (weekly.days !== null) {
    parts.push(
      weekly.cyclic
        ? `做${wm.perWeekWorkDays}休${wm.perWeekRestDays}轮换（平均每周约 ${weekly.days} 天，工作日也要排班）`
        : `每周 ${weekly.days} 天`,
    );
  }

  return parts.join('，');
}

// ==================== 薪资 ====================

/**
 * 卡片薪资段实际读取的最小 salaryScenario 字段集（同 salary-facts 的 RawSalaryScenario）；
 * raw 值仍靠 `hasValue` 逐字段兜底。
 */
interface SalaryScenario {
  salaryType?: unknown;
  salaryPeriod?: unknown;
  payday?: unknown;
  hasStairSalary?: unknown;
  stairSalaries?: unknown;
  bonusDesc?: unknown;
  basicSalary?: { basicSalary?: unknown; basicSalaryUnit?: unknown } | null;
  comprehensiveSalary?: {
    minComprehensiveSalary?: unknown;
    maxComprehensiveSalary?: unknown;
    comprehensiveSalaryUnit?: unknown;
  } | null;
  holidaySalary?: {
    holidaySalaryType?: unknown;
    holidaySalaryMultiple?: unknown;
    holidayFixedSalary?: unknown;
    holidayFixedSalaryUnit?: unknown;
  } | null;
  overtimeSalary?: {
    overtimeSalaryType?: unknown;
    overtimeSalaryMultiple?: unknown;
    overtimeFixedSalary?: unknown;
    overtimeFixedSalaryUnit?: unknown;
  } | null;
  otherSalary?: { commission?: unknown; attendanceSalary?: unknown; performance?: unknown } | null;
}

interface StairEntry {
  fullWorkTime?: unknown;
  fullWorkTimeUnit?: unknown;
  salary?: unknown;
  salaryUnit?: unknown;
  description?: unknown;
}

type LaborForm = '兼职' | '全职' | null;

const SUPPLEMENTAL_SALARY_TYPE_PATTERN = /培训|试用|试工/;

function isSupplementalScenario(s: SalaryScenario): boolean {
  return typeof s?.salaryType === 'string' && SUPPLEMENTAL_SALARY_TYPE_PATTERN.test(s.salaryType);
}

/** 正式方案优先；海绵把培训期/试用期列在前面时也只取正式方案进卡片，附属方案留给追问。 */
function pickPrimaryScenario(job: JobDetail): SalaryScenario | null {
  const scenarios: SalaryScenario[] = Array.isArray(job?.jobSalary?.salaryScenarioList)
    ? (job.jobSalary.salaryScenarioList as SalaryScenario[])
    : [];
  const valid = scenarios.filter((s) => s && typeof s === 'object');
  return valid.find((s) => !isSupplementalScenario(s)) ?? valid[0] ?? null;
}

function resolveLaborForm(job: JobDetail): LaborForm {
  const form = sanitizeLaborFormForDisplay(job?.basicInfo?.laborForm);
  return form === '兼职' || form === '全职' ? form : null;
}

function textOf(value: unknown): string {
  return hasValue(value) ? String(value).trim() : '';
}

function amount(value: unknown, unit: unknown, fallbackUnit: string): string {
  if (!hasValue(value)) return '';
  return `${String(value)}${textOf(unit) || fallbackUnit}`;
}

function formatComprehensiveRange(s: SalaryScenario): string {
  const comp = s?.comprehensiveSalary;
  const min = comp?.minComprehensiveSalary;
  const max = comp?.maxComprehensiveSalary;
  const unit = textOf(comp?.comprehensiveSalaryUnit) || '元/时';
  if (hasValue(min) && hasValue(max) && min !== max) return `${String(min)}-${String(max)}${unit}`;
  if (hasValue(min)) return `${String(min)}${unit}`;
  if (hasValue(max)) return `${String(max)}${unit}`;
  return '';
}

function formatBasic(s: SalaryScenario): string {
  return amount(s?.basicSalary?.basicSalary, s?.basicSalary?.basicSalaryUnit, '元/月');
}

/**
 * 薪资主数：兼职岗基础时薪优先（有阶梯时冠"基础"以区别各档），全职岗综合区间优先并冠"综合薪资"；
 * 用工形式缺失时沿用综合区间优先、不加前缀。
 *
 * 海绵上兼职岗普遍同时维护"基础 19 元/时"和"综合 2000-4000 元/月"两栏，候选人按小时计薪，
 * 先取综合区间就把时薪岗展示成了月薪区间；全职岗则相反，基础月薪只是综合构成的一部分。
 */
function formatBaseSalary(s: SalaryScenario, laborForm: LaborForm, hasStair: boolean): string {
  if (laborForm === '兼职') {
    const basic = formatBasic(s);
    if (basic) return hasStair ? `基础${basic}` : basic;
    return formatComprehensiveRange(s);
  }
  const comp = formatComprehensiveRange(s);
  if (comp) return laborForm === '全职' ? `综合薪资${comp}` : comp;
  return formatBasic(s);
}

function readStairs(s: SalaryScenario): StairEntry[] {
  return Array.isArray(s?.stairSalaries)
    ? (s.stairSalaries as unknown[]).filter(
        (stair): stair is StairEntry => Boolean(stair) && typeof stair === 'object',
      )
    : [];
}

function hasStairSalary(s: SalaryScenario): boolean {
  return (
    (typeof s?.hasStairSalary === 'string' && s.hasStairSalary.includes('有阶梯')) ||
    readStairs(s).some((stair) => hasValue(stair.salary))
  );
}

/** 海绵阶梯门槛单位现网全是"累计工作小时"，卡片对候选人只说"小时"。 */
function normalizeStairThresholdUnit(unit: unknown): string {
  if (typeof unit !== 'string' || !unit.trim()) return '小时';
  return unit.replace(/累计(工作)?/g, '').trim() || '小时';
}

/**
 * 阶梯段："满100小时21元/时，满190小时23元/时，超出后所有工时按照新的薪资标准计算"。
 * 计算口径只照括注原文，多档括注相同只说一次；括注为空不补。
 */
function formatStairParts(s: SalaryScenario): string[] {
  const parts: string[] = [];
  const descriptions = new Set<string>();
  for (const stair of readStairs(s)) {
    const salary = amount(stair.salary, stair.salaryUnit, '元/时');
    if (!salary) continue;
    const threshold = hasValue(stair.fullWorkTime)
      ? `满${String(stair.fullWorkTime)}${normalizeStairThresholdUnit(stair.fullWorkTimeUnit)}`
      : '';
    parts.push(`${threshold}${salary}`);
    const description = textOf(stair.description);
    if (description) descriptions.add(description);
  }
  return [...parts, ...descriptions];
}

/** 法定节假日 / 加班：多倍薪资 → "3倍"；固定薪资 → "34.5元/时"；无薪资或空 → 省略。 */
function formatMultiplierOrFixed(
  label: string,
  type: unknown,
  multiple: unknown,
  fixed: unknown,
  fixedUnit: unknown,
): string {
  const kind = textOf(type);
  if (!kind || kind === '无薪资') return '';
  if (kind === '多倍薪资') return hasValue(multiple) ? `${label}${String(multiple)}倍` : '';
  if (kind === '固定薪资') {
    const value = amount(fixed, fixedUnit, '元/时');
    return value ? `${label}${value}` : '';
  }
  return '';
}

function formatHoliday(s: SalaryScenario): string {
  const h = s?.holidaySalary;
  return formatMultiplierOrFixed(
    '法定节假日',
    h?.holidaySalaryType,
    h?.holidaySalaryMultiple,
    h?.holidayFixedSalary,
    h?.holidayFixedSalaryUnit,
  );
}

function formatOvertime(s: SalaryScenario): string {
  const o = s?.overtimeSalary;
  return formatMultiplierOrFixed(
    '加班',
    o?.overtimeSalaryType,
    o?.overtimeSalaryMultiple,
    o?.overtimeFixedSalary,
    o?.overtimeFixedSalaryUnit,
  );
}

/** 全职奖金项只上标签（"另有提成、全勤奖"），数额留给追问时按详情块回答。 */
function formatBonusLabels(s: SalaryScenario): string {
  const labels: string[] = [];
  if (hasValue(s?.otherSalary?.commission)) labels.push('提成');
  if (hasValue(s?.otherSalary?.attendanceSalary)) labels.push('全勤奖');
  if (hasValue(s?.otherSalary?.performance)) labels.push('绩效');
  if (hasValue(s?.bonusDesc)) labels.push('奖金');
  return labels.length > 0 ? `另有${labels.join('、')}` : '';
}

/** 结算："日结，当日结" / "周结，每周三发薪" / "月结，15号发薪"。 */
function formatSettlementParts(s: SalaryScenario): string[] {
  const parts: string[] = [];
  const period = textOf(s?.salaryPeriod).replace(/结算$/, '结');
  if (period) parts.push(period);
  const payday = textOf(s?.payday);
  if (payday) parts.push(/结$/.test(payday) ? payday : `${payday}发薪`);
  return parts;
}

/**
 * 卡片薪资行，按岗位类型定型：
 *  - 兼职 & 有阶梯：基础时薪 → 各档门槛 → 计算口径 → 结算（阶梯本身已够复杂，节假日/加班留给追问）
 *  - 兼职 & 无阶梯：时薪 → 法定节假日 → 加班 → 结算
 *  - 全职（含用工形式缺失）：综合薪资 → [阶梯] → 法定节假日 → 加班 → 奖金标签 → 结算
 */
function buildSalarySegment(job: JobDetail): string {
  const scenario = pickPrimaryScenario(job);
  if (!scenario) return '';
  const laborForm = resolveLaborForm(job);
  const stair = hasStairSalary(scenario);
  const base = formatBaseSalary(scenario, laborForm, stair);

  const parts: string[] = [];
  if (base) parts.push(base);
  if (laborForm === '兼职' && stair) {
    parts.push(...formatStairParts(scenario));
  } else if (laborForm === '兼职') {
    parts.push(formatHoliday(scenario), formatOvertime(scenario));
  } else {
    if (stair) parts.push(...formatStairParts(scenario));
    parts.push(formatHoliday(scenario), formatOvertime(scenario), formatBonusLabels(scenario));
  }
  parts.push(...formatSettlementParts(scenario));
  return parts.filter(Boolean).join('，');
}

// ==================== 要求 / 备注 ====================

function buildRequirementPart(hr: HardRequirements, ageText: string | null): string {
  const parts: string[] = [];
  if (ageText && ageText !== '不限') parts.push(ageText);
  if (hr.gender === 'female') parts.push('仅限女');
  else if (hr.gender === 'male') parts.push('仅限男');
  // 学生身份门槛不上候选人卡片：已知学生时 job_list 查询侧
  // 已自动剔除不接受学生岗；身份未知时走收资前单问确认，不在卡片展示身份筛选信息。
  if (hr.healthCert === 'required_before_interview') parts.push('面试前需食品健康证');
  else if (hr.healthCert === 'required_before_onboard') parts.push('入职前办食品健康证');
  if (hr.household) {
    const verb = hr.household.mode === 'include' ? '仅' : '不要';
    parts.push(`${verb}${hr.household.regions.join('/')}`);
  }
  return parts.join('，');
}

function flattenText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) return '';
  return text
    .split(/\r?\n/)
    .map((l: string) => l.replace(/\t+/g, ' ').trim())
    .filter(Boolean)
    .join('；');
}

function collectRemarks(job: JobDetail): string {
  const parts: string[] = [];
  const memo = sanitizeConstraintText(flattenText(job?.welfare?.memo));
  if (memo) parts.push(`福利备注：${memo}`);
  const wtRemark = sanitizeConstraintText(flattenText(job?.workTime?.workTimeRemark));
  if (wtRemark) parts.push(`班次备注：${wtRemark}`);
  return parts.join('\n   ');
}

// ==================== 装配 ====================

/**
 * 派生单个岗位的候选人推荐卡片。
 *
 * 输入：raw job（jobs 数组单元素），需包含 basicInfo / workTime / jobSalary / hiringRequirement / welfare。
 * 输出：oneLine + multiLine 两种 ready-to-send 模板字符串。
 */
export function renderCandidateCard(
  job: JobDetail,
  index?: number,
  distanceAnchor: DistanceAnchorPrecision | null = null,
): CandidateCard | null {
  if (!job?.basicInfo) return null;
  const bi = job.basicInfo;
  const position = resolvePositionName(bi);
  const brand = bi.brandName || '';
  // storeInfo 在契约里是 raw Record：这里按预期形状断言后直接透传，
  // 不做运行时转换（净化函数内部本就用 truthy + String() 兜底任意 raw 值）。
  const storeInfo = bi.storeInfo as { storeName?: string; storeCityName?: string } | undefined;
  const store = normalizeStoreNameForAgent(storeInfo?.storeName, storeInfo?.storeCityName);
  const distance =
    typeof job._distanceKm === 'number'
      ? formatDistanceKm(Math.round(job._distanceKm * 10) / 10, distanceAnchor)
      : '';

  const policy = buildJobPolicyAnalysis(job);
  const hr = extractHardRequirements(job, policy);

  const shift = buildShiftPart(job?.workTime);
  const salary = buildSalarySegment(job);
  const remarks = collectRemarks(job);
  const requirement = buildRequirementPart(hr, policy.normalizedRequirements.ageRequirement);

  // 标题格式：品牌（门店）- 岗位，距离
  const storePart = store ? `（${store}）` : '';
  const distPart = distance ? `，${distance}` : '';
  const head = `${brand}${storePart} - ${position}${distPart}`;
  const oneParts = [
    typeof index === 'number' ? `${index + 1}. **${head}**` : `**${head}**`,
    shift && `班次：${shift}`,
    salary && `薪资：${salary}`,
    requirement && `要求：${requirement}`,
    remarks && `${remarks}`,
  ].filter(Boolean);
  const oneLine = oneParts.join(' ｜ ');

  // 多行：标题独立成行，其余字段一行一条
  const multiLines: string[] = [
    typeof index === 'number' ? `${index + 1}. **${head}**` : `**${head}**`,
  ];
  if (shift) multiLines.push(`   班次：${shift}`);
  if (salary) multiLines.push(`   薪资：${salary}`);
  if (requirement) multiLines.push(`   要求：${requirement}`);
  if (remarks) multiLines.push(`   ${remarks}`);
  const multiLine = multiLines.join('\n');

  return {
    jobId: bi.jobId,
    oneLine,
    multiLine,
  };
}

/**
 * 渲染插在 markdown 顶部的实际岗位卡正文。
 *
 * 这里刻意不放“内部模板/固定格式/示例”等元标题：工具结果里的每一行都可以安全地
 * 被模型直接转述给候选人，从源头避免内部标题泄漏。
 * 返回空字符串表示 jobs 为空，调用方跳过插入。
 */
export function renderCandidateCardsBanner(
  jobs: JobDetail[],
  distanceAnchor: DistanceAnchorPrecision | null = null,
): string {
  if (!Array.isArray(jobs) || jobs.length === 0) return '';
  const cards = jobs
    .map((job, idx) => renderCandidateCard(job, idx, distanceAnchor))
    .filter((c): c is CandidateCard => c !== null);
  if (cards.length === 0) return '';

  const lines: string[] = [];
  for (const card of cards) {
    for (const line of card.multiLine.split('\n')) {
      lines.push(`> ${line}`);
    }
  }
  lines.push('');
  lines.push('');
  return lines.join('\n');
}
