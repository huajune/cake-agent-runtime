/**
 * duliday_job_list 工具的 markdown 渲染层（render-sections + 编排）。
 *
 * 从 duliday-job-list.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑变更）：
 * - addSummaryLine + formatInterviewDecisionSummary：约面重点 section
 * - renderBasicInfoSection / renderSalarySection / renderWelfareSection /
 *   renderHiringRequirementSection / renderWorkTimeSection / renderInterviewProcessSection：
 *   各业务 section 的 markdown 投影
 * - formatJobToOneLine / formatJobToMarkdown / formatJobsToMarkdown：单/多岗位编排
 * - inferStudentRequirement：商业语义推断（学生身份要求）
 *
 * 依赖：
 * - helpers (job-list-helpers.util)：单字段格式化 + 空值判断
 * - job-policy-parser：policy 分析 + 文本清洗
 * - labor-form：用工形式/岗位名词的 display sanitize
 * - format-shift-time：班次时间组合
 */

import { sanitizeJobDisplayText, sanitizeLaborFormForDisplay } from '@memory/facts/labor-form';
import { composeShiftTimeText } from '@tools/utils/format-shift-time.util';
import {
  buildJobPolicyAnalysis,
  cleanPolicyText,
  sanitizeConstraintText,
  type JobPolicyAnalysis,
} from '@tools/utils/job-policy-parser';
import {
  cleanNumber,
  cleanSingleLineText,
  compressWeekdays,
  formatNameWithId,
  formatRange,
  formatTimeRange,
  formatValueWithUnit,
  hasFullWeekOrRigidSchedule,
  hasValue,
  isNonEmpty,
  pushField,
  pushLongText,
} from '@tools/duliday/job-list/helpers.util';
import {
  renderMultiStoreBrandWarning,
  type BrandNearestStoresGroup,
} from '@tools/duliday/job-list/brand-stores.util';
import { normalizeStoreNameForAgent } from '@tools/duliday/job-list/sanitize.util';
import {
  extractHardRequirements,
  type HardRequirements,
} from '@tools/duliday/job-list/hard-requirements.util';
import {
  extractSalaryFacts,
  renderSalaryFactsBanner,
} from '@tools/duliday/job-list/salary-facts.util';

/**
 * 渐进式数据返回开关——控制 markdown 输出包含哪些 section。
 * 由 duliday-job-list 工具入参 schema 解析后传入 render 层。
 */
export interface ProgressiveDisclosureFlags {
  includeBasicInfo: boolean;
  includeJobSalary: boolean;
  includeWelfare: boolean;
  includeHiringRequirement: boolean;
  includeWorkTime: boolean;
  includeInterviewProcess: boolean;
}

function addSummaryLine(lines: string[], label: string, value: string | null | undefined): void {
  if (hasValue(value) && typeof value === 'string') {
    const cleaned = cleanPolicyText(value);
    if (cleaned) lines.push(`- **${label}**: ${cleaned}`);
  } else if (hasValue(value)) {
    lines.push(`- **${label}**: ${value}`);
  }
}

function formatInterviewDecisionSummary(
  policy: JobPolicyAnalysis,
  shiftTimeText?: string | null,
): string {
  const lines: string[] = [];

  if (shiftTimeText) {
    // 单/多档班次都按 normalize 后的描述展示在最显眼位置；含义（早班/午高峰短班/选其一/必须全做/星期约束/工时长度）已被组装好。
    addSummaryLine(lines, '工作班次', shiftTimeText);
  }

  if (policy.normalizedRequirements.ageRequirement !== '不限') {
    addSummaryLine(lines, '年龄要求', policy.normalizedRequirements.ageRequirement);
  }

  if (policy.normalizedRequirements.healthCertificateRequirement !== '未明确要求') {
    addSummaryLine(lines, '健康证', policy.normalizedRequirements.healthCertificateRequirement);
  }

  const studentRequirement = inferStudentRequirement(policy);
  addSummaryLine(
    lines,
    '学生身份要求',
    studentRequirement ?? '未明确（学生/在读/准研究生候选人不得据此承诺身份没限制，需确认）',
  );

  if (policy.highlights.requirementHighlights.length > 0) {
    addSummaryLine(lines, '关键要求', policy.highlights.requirementHighlights.join('；'));
  }

  if (policy.interviewMeta.method) {
    addSummaryLine(lines, '面试形式', policy.interviewMeta.method);
  }

  if (policy.interviewMeta.demand) {
    addSummaryLine(lines, '报名要求', policy.interviewMeta.demand);
  }

  if (policy.interviewMeta.timeHint) {
    addSummaryLine(lines, '面试时间', policy.interviewMeta.timeHint);
  }

  if (policy.interviewMeta.registrationDeadlineHint) {
    addSummaryLine(lines, '报名截止', policy.interviewMeta.registrationDeadlineHint);
  }

  if (policy.highlights.timingHighlights.length > 0) {
    addSummaryLine(lines, '时效限制', policy.highlights.timingHighlights.join('；'));
  }

  return lines.length > 0 ? '### 约面重点\n' + lines.join('\n') + '\n\n' : '';
}

const GENDER_LABEL: Record<HardRequirements['gender'], string | null> = {
  male: '仅限男',
  female: '仅限女',
  any: null,
  unspecified: null,
};

const HEALTH_CERT_LABEL: Record<HardRequirements['healthCert'], string | null> = {
  required_before_interview: '面试前必须持有健康证（无证不可到店）',
  required_before_onboard: '入职前必须办妥健康证（面试时可没有）',
  not_required: '岗位不需要健康证',
  unspecified: null,
};

/**
 * 顶部硬性约束 banner：把派生 enum（gender / household / healthCert）渲染成
 * 醒目的"先看这里"段，紧跟在岗位标题之后。
 *
 * 设计要点：
 * - 只有任一字段非 unspecified/any 时才输出；岗位真没要求时不污染上下文。
 * - 用 "> ⚠️ 候选人硬性约束" 引用块包裹，让 LLM 容易识别这是不可妥协的硬规则。
 * - 文案直接告诉 LLM 该如何处理（询问 / 拦 booking），避免它把硬约束当软建议处理。
 */
function renderHardRequirementsBanner(hr: HardRequirements): string {
  const lines: string[] = [];

  const genderLabel = GENDER_LABEL[hr.gender];
  if (genderLabel) {
    lines.push(`- **性别**：${genderLabel}（与候选人性别冲突则不得 booking）`);
  }

  if (hr.household) {
    const verb = hr.household.mode === 'include' ? '仅接受' : '不接受';
    lines.push(
      `- **户籍**：${verb} ${hr.household.regions.join('/')}（不掌握候选人户籍时先确认再 booking）`,
    );
  }

  const healthCertLabel = HEALTH_CERT_LABEL[hr.healthCert];
  if (healthCertLabel) {
    lines.push(`- **健康证**：${healthCertLabel}`);
  }

  if (lines.length === 0) return '';

  return [
    '> ⚠️ **候选人硬性约束**（不可妥协；与候选人 fact 冲突时不得 booking）',
    ...lines.map((l) => `> ${l}`),
    '',
    '',
  ].join('\n');
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// ==================== 模块 1：基本信息 ====================

function renderBasicInfoSection(bi: any, distanceKm: number | null | undefined): string {
  if (!bi) return '';
  const lines: string[] = [];

  // jobName / jobNickName / jobCategoryName 在渲染前剔除 "全职/正式工/临时工" 残留
  // （badcase nwr0i50f：奥乐齐分拣岗 jobName 含"全职"，Agent 转述给用户后产生混乱）。
  // 平台所有岗位都是兼职，这些词在岗位名里没有业务含义。
  pushField(lines, '岗位名称', sanitizeJobDisplayText(bi.jobName));
  pushField(lines, '岗位简称', sanitizeJobDisplayText(bi.jobNickName));
  pushField(lines, '岗位类型', sanitizeJobDisplayText(bi.jobCategoryName));
  // 渲染前 sanitize：API 偶发回 "全职/正式工" 等反向词，直接渲染会让 LLM 把岗位
  // 描述成"全职"，违反"统一按兼职口径沟通"红线（badcase #17）。
  pushField(lines, '用工形式', sanitizeLaborFormForDisplay(bi.laborForm));
  pushLongText(lines, '工作内容', bi.jobContent);

  const brand = formatNameWithId(bi.brandName, bi.brandId);
  if (brand) lines.push(`- **品牌**: ${brand}`);
  const project = formatNameWithId(bi.projectName, bi.projectId);
  if (project) lines.push(`- **项目**: ${project}`);

  const store = bi.storeInfo || {};
  const displayStoreName = normalizeStoreNameForAgent(store.storeName, store.storeCityName);
  const storeLine = formatNameWithId(displayStoreName, store.storeId);
  if (storeLine) lines.push(`- **门店**: ${storeLine}`);
  pushField(lines, '城市', store.storeCityName);
  pushField(lines, '区域', store.storeRegionName);
  pushField(lines, '地址', store.storeAddress);
  if (hasValue(store.longitude) && hasValue(store.latitude)) {
    lines.push(`- **坐标**: ${store.longitude}, ${store.latitude}`);
  }

  if (distanceKm != null && !Number.isNaN(distanceKm)) {
    lines.push(`- **距离**: ${distanceKm.toFixed(1)}km`);
  }

  pushField(lines, '创建时间', bi.createTime);
  pushField(lines, '是否需要试工', bi.needProbationWork);
  pushField(lines, '是否需要培训', bi.needTraining);
  pushField(lines, '是否有试用期', bi.haveProbation);

  return lines.length ? '### 基本信息\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 模块 2：薪资信息 ====================

function renderHolidayOrOvertimeLine(salaryObj: any, prefix: '节假日' | '加班'): string | null {
  if (!salaryObj || !isNonEmpty(salaryObj)) return null;
  const typeField = prefix === '节假日' ? 'holidaySalaryType' : 'overtimeSalaryType';
  const fixedField = prefix === '节假日' ? 'holidayFixedSalary' : 'overtimeFixedSalary';
  const fixedUnitField = prefix === '节假日' ? 'holidayFixedSalaryUnit' : 'overtimeFixedSalaryUnit';
  const multipleField = prefix === '节假日' ? 'holidaySalaryMultiple' : 'overtimeSalaryMultiple';
  const descField = prefix === '节假日' ? 'holidaySalaryDesc' : 'overtimeSalaryDesc';

  const type = salaryObj[typeField];
  let valueStr = '';
  if (type === '无薪资') {
    valueStr = '无薪资';
  } else if (type === '固定薪资') {
    const s = formatValueWithUnit(salaryObj[fixedField], salaryObj[fixedUnitField]);
    valueStr = s || '固定薪资';
  } else if (type === '多倍薪资') {
    const m = cleanNumber(salaryObj[multipleField]);
    valueStr = m !== null ? `${m} 倍` : '多倍薪资';
  } else if (hasValue(type)) {
    valueStr = String(type);
  }

  const desc = hasValue(salaryObj[descField])
    ? `（${cleanSingleLineText(String(salaryObj[descField]))}）`
    : '';

  if (!valueStr && !desc) return null;
  return `- **${prefix}薪资**: ${valueStr}${desc}`;
}

function renderSalaryScenario(scenario: any, index: number): string {
  if (!scenario || !isNonEmpty(scenario)) return '';
  const title = hasValue(scenario.salaryType) ? String(scenario.salaryType) : `方案 ${index}`;
  const lines: string[] = [];

  const periodParts: string[] = [];
  if (hasValue(scenario.salaryPeriod)) periodParts.push(String(scenario.salaryPeriod));
  if (hasValue(scenario.payday)) periodParts.push(`${scenario.payday}发薪`);
  if (periodParts.length) lines.push(`- **结算周期**: ${periodParts.join(', ')}`);

  const basic = scenario.basicSalary;
  if (basic && hasValue(basic.basicSalary)) {
    const s = formatValueWithUnit(basic.basicSalary, basic.basicSalaryUnit);
    if (s) lines.push(`- **基础薪资**: ${s}`);
  }

  const comp = scenario.comprehensiveSalary;
  if (comp && (hasValue(comp.minComprehensiveSalary) || hasValue(comp.maxComprehensiveSalary))) {
    const r = formatRange(
      comp.minComprehensiveSalary,
      comp.maxComprehensiveSalary,
      comp.comprehensiveSalaryUnit,
    );
    if (r) lines.push(`- **综合薪资**: ${r}`);
  }

  if (hasValue(scenario.hasStairSalary)) {
    lines.push(`- **是否阶梯薪资**: ${scenario.hasStairSalary}`);
  }
  if (Array.isArray(scenario.stairSalaries) && scenario.stairSalaries.length > 0) {
    const stairLines: string[] = [];
    scenario.stairSalaries.forEach((stair: any) => {
      if (!isNonEmpty(stair)) return;
      const salaryStr = formatValueWithUnit(stair.salary, stair.salaryUnit);
      if (!salaryStr) return;
      const periodPrefix = hasValue(stair.perTimeUnit) ? String(stair.perTimeUnit) : '';
      const thresholdStr = hasValue(stair.fullWorkTime)
        ? `${periodPrefix}超过 ${cleanNumber(stair.fullWorkTime)}${stair.fullWorkTimeUnit || ''}`
        : '';
      const desc = hasValue(stair.description)
        ? `（${cleanSingleLineText(String(stair.description))}）`
        : '';
      const prefix = thresholdStr ? `${thresholdStr}: ` : '';
      stairLines.push(`  - ${prefix}${salaryStr}${desc}`);
    });
    if (stairLines.length) {
      lines.push(`- **阶梯薪资**:`);
      lines.push(...stairLines);
    }
  }

  const holidayLine = renderHolidayOrOvertimeLine(scenario.holidaySalary, '节假日');
  if (holidayLine) lines.push(holidayLine);

  const overtimeLine = renderHolidayOrOvertimeLine(scenario.overtimeSalary, '加班');
  if (overtimeLine) lines.push(overtimeLine);

  const other = scenario.otherSalary;
  if (other) {
    if (hasValue(other.commission)) pushField(lines, '提成', other.commission);
    if (hasValue(other.attendanceSalary)) {
      const s = formatValueWithUnit(other.attendanceSalary, other.attendanceSalaryUnit);
      if (s) lines.push(`- **全勤奖**: ${s}`);
    }
    if (hasValue(other.performance)) pushField(lines, '绩效', other.performance);
  }

  if (Array.isArray(scenario.customSalaries) && scenario.customSalaries.length > 0) {
    scenario.customSalaries.forEach((custom: any) => {
      if (!isNonEmpty(custom) || !hasValue(custom.name)) return;
      const salaryPart = hasValue(custom.salary)
        ? formatValueWithUnit(custom.salary, custom.salaryUnit)
        : null;
      const descPart = hasValue(custom.description)
        ? cleanSingleLineText(String(custom.description))
        : null;
      const valueParts = [salaryPart, descPart].filter(Boolean).join('；');
      if (valueParts) lines.push(`- **${custom.name}**: ${valueParts}`);
    });
  }

  if (lines.length === 0) return '';
  return `#### 薪资方案 ${index}（${title}）\n${lines.join('\n')}\n`;
}

function renderProbationSalary(probation: any): string {
  if (!probation || !isNonEmpty(probation)) return '';
  const lines: string[] = [];
  if (hasValue(probation.salary)) {
    const s = formatValueWithUnit(probation.salary, probation.salaryUnit);
    if (s) lines.push(`- **薪资**: ${s}`);
  }
  if (hasValue(probation.salaryDescription)) {
    pushLongText(lines, '说明', probation.salaryDescription);
  }
  if (lines.length === 0) return '';
  return `#### 试工薪资\n${lines.join('\n')}\n`;
}

function renderSalarySection(salary: any): string {
  if (!salary) return '';
  const blocks: string[] = [];

  const scenarios = Array.isArray(salary.salaryScenarioList) ? salary.salaryScenarioList : [];
  scenarios.forEach((scenario: any, idx: number) => {
    const block = renderSalaryScenario(scenario, idx + 1);
    if (block) blocks.push(block);
  });

  const probation = renderProbationSalary(salary.probationSalary);
  if (probation) blocks.push(probation);

  if (blocks.length === 0) return '';
  // 薪资速览 banner 放在 section 头部：先告诉 LLM 哪些字段有 / 哪些没有，
  // 让它在 reply 时只引用"有"的部分，杜绝编造"节假日双倍/周末加薪"等不存在字段。
  const facts = extractSalaryFacts(salary);
  const factsBanner = renderSalaryFactsBanner(facts);
  return '### 薪资信息\n' + factsBanner + blocks.join('') + '\n';
}

// ==================== 模块 3：福利信息 ====================

function renderWelfareSection(welfare: any): string {
  if (!welfare) return '';
  const lines: string[] = [];

  if (hasValue(welfare.haveInsurance)) {
    pushField(lines, '保险', welfare.haveInsurance);
  }

  if (hasValue(welfare.accommodation)) {
    let text = String(welfare.accommodation).trim();
    if (hasValue(welfare.accommodationAllowance)) {
      const allowance = formatValueWithUnit(
        welfare.accommodationAllowance,
        welfare.accommodationAllowanceUnit,
      );
      if (allowance) text += ` ${allowance}`;
    }
    if (hasValue(welfare.probationAccommodationAllowanceReceive)) {
      text += `（试工期: ${welfare.probationAccommodationAllowanceReceive}）`;
    }
    lines.push(`- **住宿**: ${text}`);
  }

  if (hasValue(welfare.catering)) {
    let text = String(welfare.catering).trim();
    if (hasValue(welfare.cateringSalary)) {
      const val = formatValueWithUnit(welfare.cateringSalary, welfare.cateringSalaryUnit);
      if (val) text += `（餐补 ${val}）`;
    }
    lines.push(`- **餐饮**: ${text}`);
  }

  if (hasValue(welfare.trafficAllowanceSalary)) {
    const s = formatValueWithUnit(
      welfare.trafficAllowanceSalary,
      welfare.trafficAllowanceSalaryUnit,
    );
    if (s) lines.push(`- **交通补贴**: ${s}`);
  }

  pushLongText(lines, '晋升福利', welfare.promotionWelfare);

  if (Array.isArray(welfare.otherWelfare)) {
    const items = welfare.otherWelfare
      .filter((w: unknown) => hasValue(w))
      .map((w: unknown) => cleanSingleLineText(String(w)))
      .filter(Boolean);
    if (items.length) lines.push(`- **其他福利**: ${items.join('；')}`);
  }

  pushLongText(lines, '备注', welfare.memo);

  return lines.length ? '### 福利信息\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 模块 4：招聘要求 ====================

function renderHiringRequirementSection(req: any, policy: JobPolicyAnalysis): string {
  if (!req) return '';
  const lines: string[] = [];

  pushField(lines, 'figure', req.figure);

  const basic = req.basicPersonalRequirements || {};
  pushField(lines, '性别', basic.genderRequirement);
  if (hasValue(basic.minAge) || hasValue(basic.maxAge)) {
    const range = formatRange(basic.minAge, basic.maxAge, '岁');
    if (range) lines.push(`- **年龄**: ${range}`);
  }
  if (hasValue(basic.manMinHeight) || hasValue(basic.manMaxHeight)) {
    const r = formatRange(basic.manMinHeight, basic.manMaxHeight, 'cm');
    if (r) lines.push(`- **男性身高**: ${r}`);
  }
  if (hasValue(basic.womanMinHeight) || hasValue(basic.womanMaxHeight)) {
    const r = formatRange(basic.womanMinHeight, basic.womanMaxHeight, 'cm');
    if (r) lines.push(`- **女性身高**: ${r}`);
  }

  const hometown = req.requirementsForHometown || {};
  pushField(lines, '国籍要求', hometown.countryRequirementType);
  pushField(lines, '民族要求', hometown.nationRequirementType);
  if (Array.isArray(hometown.nations) && hometown.nations.length > 0) {
    lines.push(`- **民族**: ${hometown.nations.join(', ')}`);
  }
  pushField(lines, '籍贯要求', hometown.nativePlaceRequirementType);
  if (Array.isArray(hometown.nativePlaces) && hometown.nativePlaces.length > 0) {
    lines.push(`- **籍贯**: ${hometown.nativePlaces.join(', ')}`);
  }

  const mb = req.marriageBearingAndSocialSecurity || {};
  pushField(lines, '婚育要求', mb.marriageBearingType);
  pushField(lines, '婚育状态', mb.marriageBearing);
  pushField(lines, '社保要求', mb.socialSecurityRequirementType);
  if (Array.isArray(mb.socialSecurityList) && mb.socialSecurityList.length > 0) {
    lines.push(`- **社保列表**: ${mb.socialSecurityList.join(', ')}`);
  }

  const comp = req.competencyRequirements || {};
  if (hasValue(comp.minWorkTime)) {
    const s = formatValueWithUnit(comp.minWorkTime, comp.minWorkTimeUnit);
    if (s) lines.push(`- **最低工作经验**: ${s}`);
  }
  pushField(lines, '经验岗位类型', comp.workExperienceJobType);

  const lang = req.language || {};
  if (Array.isArray(lang.languages)) {
    if (lang.languages.length > 0) {
      lines.push(`- **语言**: ${lang.languages.join(', ')}`);
    }
  } else if (hasValue(lang.languages)) {
    pushField(lines, '语言', lang.languages);
  }
  pushField(lines, '语言备注', lang.languageRemark);

  const cert = req.certificate || {};
  pushField(lines, '学历', cert.education);
  if (Array.isArray(cert.certificates) && cert.certificates.length > 0) {
    lines.push(`- **证件**: ${cert.certificates.join(', ')}`);
  } else if (hasValue(cert.certificates)) {
    pushField(lines, '证件', cert.certificates);
  }
  pushField(lines, '健康证', cert.healthCertificate);
  pushField(lines, '驾照类型', cert.driverLicenseType);

  // 其他要求：优先使用 policy 清洗后的 remark（已剔除过期时效约束）
  const sanitizedRemark =
    policy.normalizedRequirements.remark ?? sanitizeConstraintText(req.remark);
  if (sanitizedRemark) pushLongText(lines, '其他要求', sanitizedRemark);

  return lines.length ? '### 招聘要求\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 模块 5：工作时间 ====================

function renderWorkTimeSection(wt: any): string {
  if (!wt) return '';
  const lines: string[] = [];

  pushField(lines, '就业形式', wt.employmentForm);
  pushField(lines, '就业形式说明', wt.employmentDescription);
  if (hasValue(wt.minWorkMonths)) {
    lines.push(`- **最少工作月数**: ${wt.minWorkMonths} 个月`);
  }

  const tempEmp = wt.temporaryEmployment || {};
  if (
    hasValue(tempEmp.temporaryEmploymentStartTime) ||
    hasValue(tempEmp.temporaryEmploymentEndTime)
  ) {
    const s = hasValue(tempEmp.temporaryEmploymentStartTime)
      ? String(tempEmp.temporaryEmploymentStartTime)
      : '?';
    const e = hasValue(tempEmp.temporaryEmploymentEndTime)
      ? String(tempEmp.temporaryEmploymentEndTime)
      : '?';
    lines.push(`- **短期用工**: ${s} 至 ${e}`);
  }

  // 每周工时
  const week = wt.weekWorkTime || {};
  const weekParts: string[] = [];
  if (hasValue(week.weekWorkTimeRequirement)) weekParts.push(String(week.weekWorkTimeRequirement));
  const daySegs: string[] = [];
  if (hasValue(week.perWeekWorkDays)) daySegs.push(`出勤 ${week.perWeekWorkDays} 天`);
  if (hasValue(week.perWeekRestDays)) daySegs.push(`休 ${week.perWeekRestDays} 天`);
  if (hasValue(week.perWeekNeedWorkDays)) daySegs.push(`需出勤 ${week.perWeekNeedWorkDays} 天`);
  if (daySegs.length) {
    if (weekParts.length) {
      weekParts.push(`(${daySegs.join(', ')})`);
    } else {
      weekParts.push(daySegs.join(', '));
    }
  }
  if (weekParts.length) lines.push(`- **每周工时**: ${weekParts.join(' ')}`);
  pushField(lines, '单双休', week.workSingleDouble);

  if (Array.isArray(week.customnWorkTimeList) && week.customnWorkTimeList.length > 0) {
    week.customnWorkTimeList.forEach((cw: any, idx: number) => {
      if (!isNonEmpty(cw)) return;
      const parts: string[] = [];
      if (hasValue(cw.customMinWorkDays) || hasValue(cw.customMaxWorkDays)) {
        const r = formatRange(cw.customMinWorkDays, cw.customMaxWorkDays, '天');
        if (r) parts.push(`出勤 ${r}`);
      }
      if (Array.isArray(cw.customWorkWeekdays) && cw.customWorkWeekdays.length > 0) {
        parts.push(`可出勤: ${compressWeekdays(cw.customWorkWeekdays.join(','))}`);
      }
      if (parts.length) lines.push(`- **自定义工时 ${idx + 1}**: ${parts.join(', ')}`);
    });
  }

  // 每月工时
  const month = wt.monthWorkTime || {};
  const monthParts: string[] = [];
  if (hasValue(month.monthWorkTimeRequirement)) {
    monthParts.push(String(month.monthWorkTimeRequirement));
  }
  if (hasValue(month.perMonthMinWorkTime)) {
    const s = formatValueWithUnit(month.perMonthMinWorkTime, month.perMonthMinWorkTimeUnit);
    if (s) monthParts.push(`最少 ${s}`);
  }
  if (hasValue(month.perMonthMaxRestTime)) {
    const s = formatValueWithUnit(month.perMonthMaxRestTime, month.perMonthMaxRestTimeUnit);
    if (s) monthParts.push(`最多休息 ${s}`);
  }
  if (monthParts.length) lines.push(`- **每月工时**: ${monthParts.join(', ')}`);

  // 每日工时
  const day = wt.dayWorkTime || {};
  if (hasValue(day.perDayMinWorkHours)) {
    const n = cleanNumber(day.perDayMinWorkHours);
    if (n !== null) lines.push(`- **每日工时**: 最少 ${n} 小时`);
  }
  pushField(lines, '每日工时要求', day.dayWorkTimeRequirement);

  // 排班
  const schedule = wt.dailyShiftSchedule;
  if (schedule) {
    pushField(lines, '排班类型', schedule.arrangementType);
    // 固定排班制特别提示：候选人不能自由挑时段，必须从固定班次里选
    // historical badcase jj2zct43：六姐兼职 arrangementType="固定排班制"，
    // Agent 答"按排班的不是每天必去，面试时沟通你想排哪些时段"，让候选人误以为可以自选时段。
    if (typeof schedule.arrangementType === 'string' && /固定排班/.test(schedule.arrangementType)) {
      lines.push(
        '- **班次自选边界**: 该岗位为固定排班制，候选人**只能在下面列出的「固定班次」里选**，不能自由挑选 11:00-14:00 / 18:00-22:00 之外的时段；门店会按候选人在已开班次里的可上班时间排班，不允许自定义时段',
      );
    }

    if (Array.isArray(schedule.fixedScheduleList) && schedule.fixedScheduleList.length > 0) {
      const shiftLines: string[] = [];
      schedule.fixedScheduleList.forEach((sh: any, idx: number) => {
        if (!isNonEmpty(sh)) return;
        const s = hasValue(sh.fixedShiftStartTime) ? String(sh.fixedShiftStartTime) : '?';
        const e = hasValue(sh.fixedShiftEndTime) ? String(sh.fixedShiftEndTime) : '?';
        shiftLines.push(`  - 班次 ${idx + 1}: ${s} - ${e}`);
      });
      if (shiftLines.length) {
        lines.push(`- **固定班次**:`);
        lines.push(...shiftLines);
      }
    }

    const ft = schedule.fixedTime || {};
    if (
      hasValue(ft.goToWorkStartTime) ||
      hasValue(ft.goToWorkEndTime) ||
      hasValue(ft.goOffWorkStartTime) ||
      hasValue(ft.goOffWorkEndTime)
    ) {
      const up = formatTimeRange(ft.goToWorkStartTime, ft.goToWorkEndTime);
      if (up) lines.push(`- **上班时间**: ${up}`);
      const off = formatTimeRange(ft.goOffWorkStartTime, ft.goOffWorkEndTime);
      if (off) lines.push(`- **下班时间**: ${off}`);
    }

    if (Array.isArray(schedule.combinedArrangement) && schedule.combinedArrangement.length > 0) {
      const caLines: string[] = [];
      schedule.combinedArrangement.forEach((ca: any, idx: number) => {
        if (!isNonEmpty(ca)) return;
        const s = hasValue(ca.combinedArrangementStartTime)
          ? String(ca.combinedArrangementStartTime)
          : '?';
        const e = hasValue(ca.combinedArrangementEndTime)
          ? String(ca.combinedArrangementEndTime)
          : '?';
        const daysSrc = hasValue(ca.combinedArrangementWeekdays)
          ? String(ca.combinedArrangementWeekdays)
          : '';
        const daysCompressed = daysSrc ? compressWeekdays(daysSrc) : '';
        const daysStr = daysCompressed ? `（${daysCompressed}）` : '';
        caLines.push(`  - 班次 ${idx + 1}: ${s} - ${e}${daysStr}`);
      });
      if (caLines.length) {
        lines.push(`- **组合排班**:`);
        lines.push(...caLines);
      }
    }
  }

  pushLongText(lines, '休息说明', wt.restTimeDesc);
  pushLongText(lines, '工时备注', sanitizeConstraintText(wt.workTimeRemark));

  if (hasFullWeekOrRigidSchedule(lines)) {
    lines.push(
      '- **排班硬约束提示**: "每天/做六休一/周一至周日/固定排班"表示工作日也要配合；候选人只做周末、每周最多几天、做一休一、下班后或只做晚班时，不能把该岗位说成"周末能排"或"晚班能排"。',
    );
  }

  return lines.length ? '### 工作时间\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 模块 6：面试流程 ====================

function renderInterviewRound(
  round: any,
  roundLabel: string,
  wayField: string,
  addressField: string,
  demandField: string,
  descField?: string,
): string[] {
  if (!round || !isNonEmpty(round)) return [];
  const sub: string[] = [];
  pushField(sub, '面试方式', round[wayField]);
  pushField(sub, '面试地址', round[addressField]);
  // demand 可能含过期时效约束，统一清洗
  pushField(sub, '面试要求', sanitizeConstraintText(round[demandField]));
  if (descField) pushLongText(sub, '说明', round[descField]);

  // 一面独有：时间模式 + 固定/周期面试时间
  if (roundLabel === '一轮面试') {
    pushField(sub, '时间模式', round.interviewTimeMode);

    if (Array.isArray(round.fixedInterviewTimes) && round.fixedInterviewTimes.length > 0) {
      const fixedLines: string[] = [];
      round.fixedInterviewTimes.forEach((ft: any) => {
        if (!isNonEmpty(ft)) return;
        const date = hasValue(ft.interviewDate) ? String(ft.interviewDate) : '';
        if (Array.isArray(ft.interviewTimes) && ft.interviewTimes.length > 0) {
          ft.interviewTimes.forEach((t: any) => {
            if (!isNonEmpty(t)) return;
            const s = hasValue(t.interviewStartTime) ? String(t.interviewStartTime) : '?';
            const e = hasValue(t.interviewEndTime) ? String(t.interviewEndTime) : '?';
            fixedLines.push(`    - ${`${date} ${s}-${e}`.trim()}`);
          });
        } else if (date) {
          fixedLines.push(`    - ${date}`);
        }
      });
      if (fixedLines.length) {
        sub.push(`- **固定面试时间**:`);
        sub.push(...fixedLines);
      }
      if (hasValue(round.fixedDeadline)) {
        sub.push(`- **固定报名截止**: ${round.fixedDeadline}`);
      }
    }

    if (Array.isArray(round.periodicInterviewTimes) && round.periodicInterviewTimes.length > 0) {
      const periodicLines: string[] = [];
      round.periodicInterviewTimes.forEach((pt: any) => {
        if (!isNonEmpty(pt)) return;
        const weekday = hasValue(pt.interviewWeekday) ? String(pt.interviewWeekday) : '';
        if (Array.isArray(pt.interviewTimes) && pt.interviewTimes.length > 0) {
          pt.interviewTimes.forEach((t: any) => {
            if (!isNonEmpty(t)) return;
            const s = hasValue(t.interviewStartTime) ? String(t.interviewStartTime) : '?';
            const e = hasValue(t.interviewEndTime) ? String(t.interviewEndTime) : '?';
            let line = `${weekday} ${s}-${e}`.trim();
            if (hasValue(t.cycleDeadlineDay) || hasValue(t.cycleDeadlineEnd)) {
              const dd = hasValue(t.cycleDeadlineDay) ? String(t.cycleDeadlineDay) : '';
              const de = hasValue(t.cycleDeadlineEnd) ? String(t.cycleDeadlineEnd) : '';
              const deadline = `${dd} ${de}`.trim();
              if (deadline) line += `（报名截止: ${deadline}）`;
            }
            periodicLines.push(`    - ${line}`);
          });
        }
      });
      if (periodicLines.length) {
        sub.push(`- **周期面试时间**:`);
        sub.push(...periodicLines);
      }
    }
  }

  if (sub.length === 0) return [];
  const header = `- **${roundLabel}**:`;
  return [header, ...sub.map((l) => `  ${l}`)];
}

function renderInterviewProcessSection(ip: any, policy: JobPolicyAnalysis): string {
  if (!ip) return '';
  const lines: string[] = [];

  if (hasValue(ip.interviewTotal)) {
    lines.push(`- **面试轮数**: ${ip.interviewTotal} 轮`);
  }

  const firstLines = renderInterviewRound(
    ip.firstInterview,
    '一轮面试',
    'firstInterviewWay',
    'interviewAddress',
    'interviewDemand',
    'firstInterviewDesc',
  );
  lines.push(...firstLines);

  const secondLines = renderInterviewRound(
    ip.secondInterview,
    '二轮面试',
    'secondInterviewWay',
    'secondInterviewAddress',
    'secondInterviewDemand',
  );
  lines.push(...secondLines);

  const thirdLines = renderInterviewRound(
    ip.thirdInterview,
    '三轮面试',
    'thirdInterviewWay',
    'thirdInterviewAddress',
    'thirdInterviewDemand',
  );
  lines.push(...thirdLines);

  if (Array.isArray(ip.interviewSupplement) && ip.interviewSupplement.length > 0) {
    const items = ip.interviewSupplement
      .map((s: any) => s?.interviewSupplement)
      .filter((s: unknown) => hasValue(s));
    if (items.length) lines.push(`- **面试补充项**: ${items.join('；')}`);
  }

  const probation = ip.probationWork;
  if (probation && isNonEmpty(probation)) {
    const sub: string[] = [];
    if (hasValue(probation.probationWorkPeriod)) {
      const s = formatValueWithUnit(
        probation.probationWorkPeriod,
        probation.probationWorkPeriodUnit,
      );
      if (s) sub.push(`- **试工周期**: ${s}`);
    }
    pushField(sub, '试工地址', probation.probationWorkAddress);
    pushField(sub, '试工考核方式', probation.probationWorkAssessment);
    pushLongText(sub, '试工考核说明', probation.probationWorkAssessmentText);
    if (sub.length) {
      lines.push(`- **试工信息**:`);
      lines.push(...sub.map((l) => `  ${l}`));
    }
  }

  const training = ip.training;
  if (training && isNonEmpty(training)) {
    const sub: string[] = [];
    pushField(sub, '培训地址', training.trainingAddress);
    if (hasValue(training.trainingPeriod)) {
      const s = formatValueWithUnit(training.trainingPeriod, training.trainingPeriodUnit);
      if (s) sub.push(`- **培训周期**: ${s}`);
    }
    pushLongText(sub, '培训说明', training.trainingDesc);
    if (sub.length) {
      lines.push(`- **培训信息**:`);
      lines.push(...sub.map((l) => `  ${l}`));
    }
  }

  pushLongText(lines, '流程说明', ip.processDesc);

  // 面试备注：使用 policy 清洗过的 interviewRemark（已剔除过期时效等噪音）
  if (policy.normalizedRequirements.interviewRemark) {
    pushLongText(lines, '面试备注', policy.normalizedRequirements.interviewRemark);
  }

  return lines.length ? '### 面试流程\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 岗位格式化 ====================

function formatJobToOneLine(job: any, index: number): string {
  const bi = job.basicInfo;
  const store = bi.storeInfo;
  const parts = [`${index + 1}. **${bi.brandName || ''} - ${bi.jobName || '未命名'}**`];
  const displayStoreName = normalizeStoreNameForAgent(store?.storeName, store?.storeCityName);
  if (displayStoreName) parts.push(displayStoreName);
  if (store?.storeAddress) parts.push(store.storeAddress);
  if (job._distanceKm != null) parts.push(`距离 ${job._distanceKm.toFixed(1)}km`);
  return parts.join(' | ');
}

function isMinimalMode(flags: ProgressiveDisclosureFlags): boolean {
  return (
    flags.includeBasicInfo &&
    !flags.includeJobSalary &&
    !flags.includeWelfare &&
    !flags.includeHiringRequirement &&
    !flags.includeWorkTime &&
    !flags.includeInterviewProcess
  );
}

function formatJobToMarkdown(job: any, index: number, flags: ProgressiveDisclosureFlags): string {
  const bi = job.basicInfo;
  const policy = buildJobPolicyAnalysis(job);
  const titleParts = [bi.jobName || '未命名岗位'];
  if (hasValue(bi.jobNickName) && bi.jobNickName !== bi.jobName) {
    titleParts.push(`(${bi.jobNickName})`);
  }
  let md = `## ${index + 1}. ${titleParts.join(' ')}\n\n`;

  // 硬性约束 banner 紧跟标题：性别 / 户籍 / 健康证 三类高频硬约束，
  // 任一非 unspecified/any 时才输出。让 LLM 一眼看到不可妥协的硬规则。
  md += renderHardRequirementsBanner(extractHardRequirements(job, policy));

  // 候选人需要 workTime 时（默认开）才注入归一化班次（含早/中/晚班/午高峰/星期约束等含义）；
  // 模型显式关 includeWorkTime 表示本轮在做不涉及班次的追问，无需归一化班次。
  // 数据缺失时为 null，约面重点 section 不显示该行。
  const shiftTimeText = flags.includeWorkTime ? composeShiftTimeText(job.workTime) : null;

  if (flags.includeHiringRequirement || flags.includeInterviewProcess) {
    md += formatInterviewDecisionSummary(policy, shiftTimeText);
  }
  if (flags.includeBasicInfo) {
    md += renderBasicInfoSection(job.basicInfo, job._distanceKm);
  }
  if (flags.includeJobSalary) {
    md += renderSalarySection(job.jobSalary);
  }
  if (flags.includeWelfare) {
    md += renderWelfareSection(job.welfare);
  }
  if (flags.includeHiringRequirement) {
    md += renderHiringRequirementSection(job.hiringRequirement, policy);
  }
  if (flags.includeWorkTime) {
    md += renderWorkTimeSection(job.workTime);
  }
  if (flags.includeInterviewProcess) {
    md += renderInterviewProcessSection(job.interviewProcess, policy);
  }

  md += '### 岗位标识\n';
  md += `- **jobId**: ${bi.jobId}\n\n`;
  return md;
}

export function formatJobsToMarkdown(
  jobs: any[],
  total: number,
  pageNum: number,
  pageSize: number,
  flags: ProgressiveDisclosureFlags,
  brandGroups: BrandNearestStoresGroup[] | null = null,
): string {
  const start = (pageNum - 1) * pageSize + 1;
  const end = Math.min(start + jobs.length - 1, total);

  let md = `# 在招岗位（共 ${total} 个）\n\n`;

  // 同品牌多门店强约束置顶（badcase laybqxn4：同品牌两家被压缩成"有肯德基、肯德基"）
  const multiStoreSection = renderMultiStoreBrandWarning(brandGroups);
  if (multiStoreSection) {
    md += multiStoreSection;
  }

  if (isMinimalMode(flags)) {
    jobs.forEach((job, index) => {
      md += formatJobToOneLine(job, start + index - 1) + '\n';
    });
    if (total > end) md += `\n_还有 ${total - end} 个岗位未显示，可通过筛选条件缩小范围_\n`;
    return md;
  }

  md += `当前显示第 ${start}-${end} 条\n\n---\n\n`;
  jobs.forEach((job, index) => {
    md += formatJobToMarkdown(job, index, flags);
    md += '---\n\n';
  });
  return md;
}

export function inferStudentRequirement(policy: JobPolicyAnalysis): string | null {
  const text = [
    policy.normalizedRequirements.remark,
    policy.normalizedRequirements.interviewRemark,
    policy.interviewMeta.demand,
    ...policy.highlights.requirementHighlights,
    ...policy.fieldGuidance.fieldSignals
      .filter((signal) => signal.field === '是否学生')
      .map((signal) => signal.evidence),
  ]
    .filter((item): item is string => Boolean(item && item.trim()))
    .join('；');
  if (!text) return null;

  const normalized = text.replace(/\s+/g, '');
  if (/(不招学生|学生勿扰|学生不考虑|仅限非学生|非学生优先|需要已毕业|社会人士)/.test(normalized)) {
    return '不接受学生';
  }
  if (/(学生优先|在校生优先)/.test(normalized)) {
    return '学生优先';
  }
  if (/(接受学生|可接受学生|在校生可|学生可报名|学生也可)/.test(normalized)) {
    return '可接受学生';
  }

  return null;
}
