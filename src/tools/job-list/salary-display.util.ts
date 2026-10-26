// business-rules: SW-09
/**
 * 岗位薪资主数（推荐卡片薪资行开头 / 更远门店摘要行 / 会话记忆 salaryDesc 的唯一来源）。
 *
 * 口径（PR #1322 产品定型）：
 * - 只取正式方案；培训期/试用期方案排在前面时也跳过，留给追问；
 * - 兼职岗按小时计薪：基础薪资（时薪）优先于综合薪资区间——海绵兼职岗普遍同时维护
 *   "基础 19 元/时"和"综合 2000-4000 元/月"两栏，先取综合就会把时薪岗说成月薪；
 * - 全职岗与用工形式缺失：综合薪资区间优先，基础薪资兜底；
 * - 单位缺失时只写"元"，不替岗位补"/时"或"/月"——补错单位正是时薪岗被说成月薪的来源。
 *
 * 卡片在主数前加"基础"/"综合薪资"前缀并拼阶梯/节假日/结算，摘要行与记忆直接用主数；
 * 两处不得再各写一份取值逻辑。
 */

import { hasValue } from '@tools/job-list/helpers.util';
import { sanitizeLaborFormForDisplay } from '@resolution/labor-form';

/** 主数实际读取的最小 salaryScenario 字段集（raw 值靠 hasValue 逐字段兜底）。 */
export interface SalaryHeadlineScenario {
  salaryType?: unknown;
  basicSalary?: { basicSalary?: unknown; basicSalaryUnit?: unknown } | null;
  comprehensiveSalary?: {
    minComprehensiveSalary?: unknown;
    maxComprehensiveSalary?: unknown;
    comprehensiveSalaryUnit?: unknown;
  } | null;
}

/** 主数实际读取的最小 job 字段集；JobDetail 与各工具侧的 raw job 视图都满足。 */
export interface SalaryHeadlineJob {
  basicInfo?: { laborForm?: unknown } | null;
  jobSalary?: { salaryScenarioList?: unknown } | null;
}

export type SalaryLaborForm = '兼职' | '全职' | null;

export interface SalaryHeadline {
  /** 不带前缀的主数，如 `25.5元/时`、`5000-6000元/月`。 */
  text: string;
  /** 主数取自基础薪资还是综合薪资。 */
  source: 'basic' | 'comprehensive';
  laborForm: SalaryLaborForm;
}

/** 单位缺失时的中性兜底：只说"元"，不推断计薪周期。 */
const UNKNOWN_SALARY_UNIT = '元';

const SUPPLEMENTAL_SALARY_TYPE_PATTERN = /培训|试用|试工/;

function textOf(value: unknown): string {
  return hasValue(value) ? String(value).trim() : '';
}

export function isSupplementalSalaryScenario(scenario: SalaryHeadlineScenario): boolean {
  return (
    typeof scenario?.salaryType === 'string' &&
    SUPPLEMENTAL_SALARY_TYPE_PATTERN.test(scenario.salaryType)
  );
}

/** 正式方案优先；全是附属方案时退回第一条。 */
export function pickPrimarySalaryScenario<T extends SalaryHeadlineScenario>(
  job: SalaryHeadlineJob,
): T | null {
  const list = job?.jobSalary?.salaryScenarioList;
  const scenarios = Array.isArray(list)
    ? (list as unknown[]).filter(
        (item): item is T => item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
  return scenarios.find((item) => !isSupplementalSalaryScenario(item)) ?? scenarios[0] ?? null;
}

export function resolveSalaryLaborForm(job: SalaryHeadlineJob): SalaryLaborForm {
  const raw = job?.basicInfo?.laborForm;
  const form = sanitizeLaborFormForDisplay(typeof raw === 'string' ? raw : null);
  return form === '兼职' || form === '全职' ? form : null;
}

/** 综合薪资区间：`2000-4000元/月`；上下限相同或只有一端时写单值。 */
export function formatComprehensiveSalary(scenario: SalaryHeadlineScenario): string {
  const comp = scenario?.comprehensiveSalary;
  const min = comp?.minComprehensiveSalary;
  const max = comp?.maxComprehensiveSalary;
  const unit = textOf(comp?.comprehensiveSalaryUnit) || UNKNOWN_SALARY_UNIT;
  if (hasValue(min) && hasValue(max) && String(min) !== String(max)) {
    return `${String(min)}-${String(max)}${unit}`;
  }
  if (hasValue(min)) return `${String(min)}${unit}`;
  if (hasValue(max)) return `${String(max)}${unit}`;
  return '';
}

/** 基础薪资：`19元/时`。 */
export function formatBasicSalary(scenario: SalaryHeadlineScenario): string {
  const basic = scenario?.basicSalary;
  if (!hasValue(basic?.basicSalary)) return '';
  return `${String(basic?.basicSalary)}${textOf(basic?.basicSalaryUnit) || UNKNOWN_SALARY_UNIT}`;
}

/** 岗位薪资主数；没有任何正式/附属方案金额时返回 null。 */
export function resolveSalaryHeadline(job: SalaryHeadlineJob): SalaryHeadline | null {
  const scenario = pickPrimarySalaryScenario(job);
  if (!scenario) return null;
  const laborForm = resolveSalaryLaborForm(job);
  const basic = formatBasicSalary(scenario);
  const comprehensive = formatComprehensiveSalary(scenario);
  const order: Array<SalaryHeadline['source']> =
    laborForm === '兼职' ? ['basic', 'comprehensive'] : ['comprehensive', 'basic'];
  for (const source of order) {
    const text = source === 'basic' ? basic : comprehensive;
    if (text) return { text, source, laborForm };
  }
  return null;
}
