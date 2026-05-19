/**
 * 从 raw job.jobSalary 派生结构化 SalaryFacts（Phase 1.B.4 数据契约层）。
 *
 * 历史 badcase 簇 salary_fabrication：Agent 在回复里编造"节假日双倍/周末加薪/
 * 工资浮动/薪资面议"等本平台没有的薪资口径——常因为：
 *  1. 受候选人发来的其它平台截图污染（zt98hgy3）
 *  2. 把"阶梯薪资"理解成"按业绩浮动"（aalxnd77）
 *
 * 让 LLM 在 render 顶部就看到"薪资速览"（哪些字段有 / 哪些字段没有），
 * 把"工具没返回 X 就别说 X"这件事从 prompt 红线层下沉到数据契约层。
 *
 * 同时给 reply-fact-guard 提供一个稳定的结构化检查点：替代 ad-hoc
 * hasNonEmptyHolidayOrOvertimeSalary，统一从这一层取信号。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SalaryFacts {
  /** 是否至少有一个 scenario 写了 basicSalary（基础薪资） */
  hasBaseSalary: boolean;
  /** 是否至少有一个 scenario 写了 comprehensiveSalary 范围（综合薪资） */
  hasComprehensiveSalary: boolean;
  /** 是否至少有一个 scenario 标了 hasStairSalary=是 或 stairSalaries 非空（阶梯薪资） */
  hasStairSalary: boolean;
  /** holidaySalary.holidaySalaryType 至少有一个非 "无薪资"（节假日薪资差异） */
  hasHolidayBonus: boolean;
  /** overtimeSalary.overtimeSalaryType 至少有一个非 "无薪资"（加班费） */
  hasOvertimeBonus: boolean;
  /** otherSalary.commission 非空（提成） */
  hasCommission: boolean;
  /** otherSalary.attendanceSalary 非空（全勤奖） */
  hasAttendanceBonus: boolean;
  /** otherSalary.performance 非空（绩效） */
  hasPerformance: boolean;
  /** probationSalary 块非空（试工/试用期薪资） */
  hasProbationSalary: boolean;
  /** 任一字符串字段含"面议/电议/详谈" → 提示薪资有协商空间，不要复述死数字 */
  hasNegotiableHint: boolean;
}

const EMPTY_SALARY_FACTS: SalaryFacts = {
  hasBaseSalary: false,
  hasComprehensiveSalary: false,
  hasStairSalary: false,
  hasHolidayBonus: false,
  hasOvertimeBonus: false,
  hasCommission: false,
  hasAttendanceBonus: false,
  hasPerformance: false,
  hasProbationSalary: false,
  hasNegotiableHint: false,
};

const NEGOTIABLE_PATTERN = /面议|电议|详谈/;

function hasNonEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return !Number.isNaN(value);
  return Boolean(value);
}

function containsNegotiable(value: unknown): boolean {
  return typeof value === 'string' && NEGOTIABLE_PATTERN.test(value);
}

/**
 * 顶层入口：从 raw job.jobSalary 派生 SalaryFacts。
 *
 * 对 raw 结构容忍——任一字段类型异常都退化为 false，不抛错。
 * 没有 salary 块时返回 EMPTY_SALARY_FACTS（全 false）。
 */
export function extractSalaryFacts(jobSalary: unknown): SalaryFacts {
  if (!jobSalary || typeof jobSalary !== 'object') return { ...EMPTY_SALARY_FACTS };
  const salary = jobSalary as any;

  const facts: SalaryFacts = { ...EMPTY_SALARY_FACTS };

  const scenarios = Array.isArray(salary.salaryScenarioList) ? salary.salaryScenarioList : [];
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== 'object') continue;
    const s = scenario as any;

    if (hasNonEmptyValue(s.basicSalary?.basicSalary)) facts.hasBaseSalary = true;
    if (
      hasNonEmptyValue(s.comprehensiveSalary?.minComprehensiveSalary) ||
      hasNonEmptyValue(s.comprehensiveSalary?.maxComprehensiveSalary)
    ) {
      facts.hasComprehensiveSalary = true;
    }
    if (
      s.hasStairSalary === '是' ||
      (Array.isArray(s.stairSalaries) && s.stairSalaries.length > 0)
    ) {
      facts.hasStairSalary = true;
    }

    const holidayType = s.holidaySalary?.holidaySalaryType;
    if (typeof holidayType === 'string' && holidayType.trim() && holidayType !== '无薪资') {
      facts.hasHolidayBonus = true;
    }
    const overtimeType = s.overtimeSalary?.overtimeSalaryType;
    if (typeof overtimeType === 'string' && overtimeType.trim() && overtimeType !== '无薪资') {
      facts.hasOvertimeBonus = true;
    }

    if (hasNonEmptyValue(s.otherSalary?.commission)) facts.hasCommission = true;
    if (hasNonEmptyValue(s.otherSalary?.attendanceSalary)) facts.hasAttendanceBonus = true;
    if (hasNonEmptyValue(s.otherSalary?.performance)) facts.hasPerformance = true;

    if (
      containsNegotiable(s.salaryPeriod) ||
      containsNegotiable(s.payday) ||
      containsNegotiable(s.basicSalary?.basicSalary) ||
      containsNegotiable(s.holidaySalary?.holidaySalaryDesc) ||
      containsNegotiable(s.overtimeSalary?.overtimeSalaryDesc) ||
      containsNegotiable(s.otherSalary?.commission) ||
      containsNegotiable(s.otherSalary?.performance)
    ) {
      facts.hasNegotiableHint = true;
    }
  }

  if (salary.probationSalary && typeof salary.probationSalary === 'object') {
    const probation = salary.probationSalary as any;
    if (hasNonEmptyValue(probation.salary) || hasNonEmptyValue(probation.salaryDescription)) {
      facts.hasProbationSalary = true;
    }
    if (containsNegotiable(probation.salary) || containsNegotiable(probation.salaryDescription)) {
      facts.hasNegotiableHint = true;
    }
  }

  return facts;
}

/**
 * 把 SalaryFacts 渲染成给 Agent 看的紧凑提醒——只列出"工具里有这些薪资字段、
 * 没有这些字段"，让 Agent 不要在 reply 里凭空说工具没返回的薪资项。
 *
 * 返回空字符串表示 salary 全空，render 层不需要插入这个 banner。
 */
export function renderSalaryFactsBanner(facts: SalaryFacts): string {
  const present: string[] = [];
  const absent: string[] = [];

  const push = (label: string, has: boolean) => (has ? present : absent).push(label);
  push('基础/综合薪资', facts.hasBaseSalary || facts.hasComprehensiveSalary);
  push('阶梯薪资', facts.hasStairSalary);
  push('节假日薪资差异', facts.hasHolidayBonus);
  push('加班费', facts.hasOvertimeBonus);
  push('提成/绩效', facts.hasCommission || facts.hasPerformance);
  push('全勤奖', facts.hasAttendanceBonus);
  push('试工/试用期薪资', facts.hasProbationSalary);

  // 全 false：jobSalary 块整个为空。让上层不渲染 banner（也不渲染 section）。
  if (present.length === 0) return '';

  const lines: string[] = [];
  lines.push('> 💰 **薪资字段速览**（reply 时只能引用"有"的部分，不得编造"没有"的部分）');
  lines.push(`> - 有：${present.join('、')}`);
  if (absent.length > 0) {
    lines.push(`> - 没有：${absent.join('、')}（不得在 reply 里声称岗位有这些）`);
  }
  if (facts.hasNegotiableHint) {
    lines.push(
      '> - ⚠️ 薪资文本含"面议/电议/详谈"——具体数字以面试时招募经理告知为准，不要在群里复述确定数额',
    );
  }
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

/* eslint-enable @typescript-eslint/no-explicit-any */
