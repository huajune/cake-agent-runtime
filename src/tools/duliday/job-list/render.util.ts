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
import type { JobDetail } from '@sponge/sponge.types';
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
  formatNameWithId,
  formatRange,
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
import {
  extractWelfareFacts,
  renderWelfareFactsBanner,
} from '@tools/duliday/job-list/welfare-facts.util';
import { renderCandidateCardsBanner } from '@tools/duliday/job-list/candidate-card.util';

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

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => !!item)
    : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

// ==================== 模块 1：基本信息 ====================

function renderBasicInfoSection(basicInfo: unknown, distanceKm: number | null | undefined): string {
  const bi = asRecord(basicInfo);
  if (!bi) return '';
  const lines: string[] = [];

  // jobName / jobNickName / jobCategoryName 在渲染前剔除 "全职/正式工/临时工" 残留
  // （badcase nwr0i50f：奥乐齐分拣岗 jobName 含"全职"，Agent 转述给用户后产生混乱）。
  // 平台所有岗位都是兼职，这些词在岗位名里没有业务含义。
  pushField(lines, '岗位名称', sanitizeJobDisplayText(asString(bi.jobName)));
  pushField(lines, '岗位简称', sanitizeJobDisplayText(asString(bi.jobNickName)));
  pushField(lines, '岗位类型', sanitizeJobDisplayText(asString(bi.jobCategoryName)));
  // 渲染前 sanitize：API 偶发回 "全职/正式工" 等反向词，直接渲染会让 LLM 把岗位
  // 描述成"全职"，违反"统一按兼职口径沟通"红线（badcase #17）。
  pushField(lines, '用工形式', sanitizeLaborFormForDisplay(asString(bi.laborForm)));
  pushLongText(lines, '工作内容', bi.jobContent);

  const brand = formatNameWithId(bi.brandName, bi.brandId);
  if (brand) lines.push(`- **品牌**: ${brand}`);
  const project = formatNameWithId(bi.projectName, bi.projectId);
  if (project) lines.push(`- **项目**: ${project}`);

  const store = asRecord(bi.storeInfo) ?? {};
  const displayStoreName = normalizeStoreNameForAgent(
    asString(store.storeName),
    asString(store.storeCityName),
  );
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

function renderHolidayOrOvertimeLine(
  salaryInput: unknown,
  prefix: '节假日' | '加班',
): string | null {
  const salaryObj = asRecord(salaryInput);
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

function renderSalaryScenario(scenarioInput: unknown, index: number): string {
  const scenario = asRecord(scenarioInput);
  if (!scenario || !isNonEmpty(scenario)) return '';
  const title = hasValue(scenario.salaryType) ? String(scenario.salaryType) : `方案 ${index}`;
  const lines: string[] = [];

  const periodParts: string[] = [];
  if (hasValue(scenario.salaryPeriod)) periodParts.push(String(scenario.salaryPeriod));
  if (hasValue(scenario.payday)) periodParts.push(`${scenario.payday}发薪`);
  if (periodParts.length) lines.push(`- **结算周期**: ${periodParts.join(', ')}`);

  const basic = asRecord(scenario.basicSalary);
  if (basic && hasValue(basic.basicSalary)) {
    const s = formatValueWithUnit(basic.basicSalary, basic.basicSalaryUnit);
    if (s) lines.push(`- **基础薪资**: ${s}`);
  }

  const comp = asRecord(scenario.comprehensiveSalary);
  if (comp && (hasValue(comp.minComprehensiveSalary) || hasValue(comp.maxComprehensiveSalary))) {
    const r = formatRange(
      comp.minComprehensiveSalary,
      comp.maxComprehensiveSalary,
      comp.comprehensiveSalaryUnit,
    );
    if (r) lines.push(`- **综合薪资**: ${r}`);
  }

  // hasStairSalary 取值是 "有阶梯薪资"/"无阶梯薪资"，仅在"有"时提示（下方会列明细），
  // 避免把"无阶梯薪资"渲染成一条看似有内容的字段误导 LLM。
  if (typeof scenario.hasStairSalary === 'string' && scenario.hasStairSalary.includes('有阶梯')) {
    lines.push(`- **是否阶梯薪资**: 有阶梯薪资`);
  }
  const stairSalaries = asRecordArray(scenario.stairSalaries);
  if (stairSalaries.length > 0) {
    const stairLines: string[] = [];
    stairSalaries.forEach((stair) => {
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

  const other = asRecord(scenario.otherSalary);
  if (other) {
    if (hasValue(other.commission)) pushField(lines, '提成', other.commission);
    if (hasValue(other.attendanceSalary)) {
      const s = formatValueWithUnit(other.attendanceSalary, other.attendanceSalaryUnit);
      if (s) lines.push(`- **全勤奖**: ${s}`);
    }
    if (hasValue(other.performance)) pushField(lines, '绩效', other.performance);
  }

  // 特殊时段薪资（夜班津贴等）：真实字段是 jobSpecialSalaryList（旧的 customSalaries 现网不返回）。
  const specialSalaries = asRecordArray(scenario.jobSpecialSalaryList);
  if (specialSalaries.length > 0) {
    const specialLines: string[] = [];
    specialSalaries.forEach((special) => {
      if (!isNonEmpty(special)) return;
      const salaryPart = hasValue(special.specialSalary)
        ? formatValueWithUnit(special.specialSalary, special.specialSalaryUnit)
        : null;
      const timeRange =
        hasValue(special.startTime) && hasValue(special.endTime)
          ? `${special.startTime}-${special.endTime}`
          : '';
      const remark = hasValue(special.specialSalaryRemark)
        ? cleanSingleLineText(String(special.specialSalaryRemark))
        : '';
      const parts = [
        salaryPart ? `+${salaryPart}` : null,
        timeRange ? `（${timeRange}）` : null,
        remark || null,
      ].filter(Boolean);
      if (parts.length) specialLines.push(`  - ${parts.join(' ')}`);
    });
    if (specialLines.length) {
      lines.push(`- **特殊时段薪资**:`);
      lines.push(...specialLines);
    }
  }

  if (lines.length === 0) return '';
  return `#### 薪资方案 ${index}（${title}）\n${lines.join('\n')}\n`;
}

function renderProbationSalary(probationInput: unknown): string {
  const probation = asRecord(probationInput);
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

function renderSalarySection(salaryInput: unknown): string {
  const salary = asRecord(salaryInput);
  if (!salary) return '';
  const blocks: string[] = [];

  const scenarios = Array.isArray(salary.salaryScenarioList) ? salary.salaryScenarioList : [];
  scenarios.forEach((scenario, idx: number) => {
    const block = renderSalaryScenario(scenario, idx + 1);
    if (block) blocks.push(block);
  });

  const probation = renderProbationSalary(salary.probationSalary);
  if (probation) blocks.push(probation);

  if (blocks.length === 0) return '';
  const facts = extractSalaryFacts(salary);
  const factsBanner = renderSalaryFactsBanner(facts);
  return '### 薪资信息\n' + factsBanner + blocks.join('') + '\n';
}

// ==================== 模块 3：福利信息 ====================

function renderWelfareSection(welfareInput: unknown): string {
  const welfare = asRecord(welfareInput);
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

  if (lines.length === 0) return '';
  // 福利速览 banner 放在 section 头部：把"员工自理/不购买"这类易被压缩成"有"的
  // 字面值显式标 ❌ 无；让 LLM 在 reply 时只引用 ✅/💵 项，不编造工具未返回的福利。
  const factsBanner = renderWelfareFactsBanner(extractWelfareFacts(welfare));
  return '### 福利信息\n' + factsBanner + lines.join('\n') + '\n\n';
}

// ==================== 模块 4：招聘要求 ====================

function renderHiringRequirementSection(reqInput: unknown, policy: JobPolicyAnalysis): string {
  const req = asRecord(reqInput);
  if (!req) return '';
  const lines: string[] = [];

  pushField(lines, 'figure', req.figure);

  const basic = asRecord(req.basicPersonalRequirements) ?? {};
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

  const hometown = asRecord(req.requirementsForHometown) ?? {};
  pushField(lines, '国籍要求', hometown.countryRequirementType);
  pushField(lines, '民族要求', hometown.nationRequirementType);
  if (Array.isArray(hometown.nations) && hometown.nations.length > 0) {
    lines.push(`- **民族**: ${hometown.nations.join(', ')}`);
  }
  pushField(lines, '籍贯要求', hometown.nativePlaceRequirementType);
  if (Array.isArray(hometown.nativePlaces) && hometown.nativePlaces.length > 0) {
    lines.push(`- **籍贯**: ${hometown.nativePlaces.join(', ')}`);
  }

  const mb = asRecord(req.marriageBearingAndSocialSecurity) ?? {};
  pushField(lines, '婚育要求', mb.marriageBearingType);
  pushField(lines, '婚育状态', mb.marriageBearing);
  // socialSecurityList 现网是字符串（如"公司缴纳本地社保"/"无公司在缴社保流水"），
  // 旧代码按数组读会整段丢失；这里兼容字符串与历史数组两种形态。
  // socialSecurityRequirementType 现网不返回，已移除。
  if (Array.isArray(mb.socialSecurityList) && mb.socialSecurityList.length > 0) {
    lines.push(`- **社保**: ${mb.socialSecurityList.join(', ')}`);
  } else {
    pushField(lines, '社保', mb.socialSecurityList);
  }

  const comp = asRecord(req.competencyRequirements) ?? {};
  if (hasValue(comp.minWorkTime)) {
    const s = formatValueWithUnit(comp.minWorkTime, comp.minWorkTimeUnit);
    if (s) lines.push(`- **最低工作经验**: ${s}`);
  }
  pushField(lines, '经验岗位类型', comp.workExperienceJobType);

  const lang = asRecord(req.language) ?? {};
  if (Array.isArray(lang.languages)) {
    if (lang.languages.length > 0) {
      lines.push(`- **语言**: ${lang.languages.join(', ')}`);
    }
  } else if (hasValue(lang.languages)) {
    pushField(lines, '语言', lang.languages);
  }
  pushField(lines, '语言备注', lang.languageRemark);

  const cert = asRecord(req.certificate) ?? {};
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
    policy.normalizedRequirements.remark ?? sanitizeConstraintText(asString(req.remark));
  if (sanitizedRemark) pushLongText(lines, '其他要求', sanitizedRemark);

  return lines.length ? '### 招聘要求\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 模块 5：工作时间 ====================

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function toCnNum(value: unknown): string {
  const n = cleanNumber(value);
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10
    ? CN_NUM[n]
    : String(value);
}

function renderWorkTimeSection(workTimeInput: unknown): string {
  const wt = asRecord(workTimeInput);
  if (!wt) return '';
  const lines: string[] = [];

  pushField(lines, '就业形式', wt.employmentForm);
  if (hasValue(wt.minWorkMonths)) {
    lines.push(`- **最少工作月数**: ${wt.minWorkMonths} 个月`);
  }

  // 阶段用工时间窗
  const tempEmp = asRecord(wt.temporaryEmployment) ?? {};
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
    lines.push(`- **阶段用工**: ${s} 至 ${e}`);
  }

  // 每周/每月排班（海绵2.0 weekAndMonthWorkTime）
  const wm = asRecord(wt.weekAndMonthWorkTime) ?? {};
  const cycleLabel = hasValue(wm.arrangementCycleType) ? String(wm.arrangementCycleType) : '';
  const wmParts: string[] = [];
  // 做X休Y（用中文数字以触发"做六休一"等全周强排班识别）
  if (hasValue(wm.perWeekWorkDays) && hasValue(wm.perWeekRestDays)) {
    wmParts.push(`做${toCnNum(wm.perWeekWorkDays)}休${toCnNum(wm.perWeekRestDays)}`);
  } else if (hasValue(wm.perWeekWorkDays)) {
    wmParts.push(`每周出勤 ${wm.perWeekWorkDays} 天`);
  } else if (hasValue(wm.perWeekRestDays)) {
    wmParts.push(`每周休 ${wm.perWeekRestDays} 天`);
  }
  // 至少/至多上岗 N 天/小时
  if (hasValue(wm.onWorkTime) && hasValue(wm.onWorkTimeUnit)) {
    const limit = hasValue(wm.onWorkLimitType) ? String(wm.onWorkLimitType) : '上岗';
    wmParts.push(`${limit} ${wm.onWorkTime} ${wm.onWorkTimeUnit}`);
  }
  // 休息模式（周中休/周末休）
  if (hasValue(wm.weekMonthRestMode)) wmParts.push(String(wm.weekMonthRestMode));
  // 单双号
  if (hasValue(wm.workSingleDouble)) wmParts.push(`仅${wm.workSingleDouble}`);
  if (wmParts.length) {
    const cyclePrefix = cycleLabel ? `${cycleLabel}: ` : '';
    lines.push(`- **排班周期**: ${cyclePrefix}${wmParts.join('，')}`);
  }

  // 每日排班（海绵2.0 dayWorkTime）
  const day = asRecord(wt.dayWorkTime) ?? {};
  const arrangementType = hasValue(day.arrangementType) ? String(day.arrangementType) : '';
  if (arrangementType) {
    pushField(lines, '排班类型', arrangementType);
    // 组合排班制（满足所有时段）：下列时段全部都要出勤，不能只挑一段。
    if (/所有/.test(arrangementType)) {
      lines.push(
        '- **班次硬约束提示**: 该岗位为组合排班制，下面列出的「可排时段」**全部都要出勤**，候选人不能只挑其中一段',
      );
    } else if (/其中一个|其中一/.test(arrangementType)) {
      // 固定排班制（满足其中一个时段即可）：候选人只能从已开时段里选，不能自定义时段。
      // historical badcase jj2zct43：固定排班制被答成"面试时沟通你想排哪些时段"，让候选人误以为可自选。
      lines.push(
        '- **班次自选边界**: 该岗位为固定排班制，候选人**只能在下面列出的「可排时段」里选**，不能自由挑选未列出的时段；门店按候选人可上班时间在已开时段里排班',
      );
    }
  }

  // 每日最少工时 + 班次名 + 上下班区间（灵活排班 fixedTime）
  const ft = asRecord(day.fixedTime) ?? {};
  if (hasValue(ft.perDayMinWorkHours)) {
    const n = cleanNumber(ft.perDayMinWorkHours);
    if (n !== null) lines.push(`- **每日工时**: 最少 ${n} 小时`);
  }
  if (Array.isArray(ft.shiftCodes)) {
    const codes = ft.shiftCodes.filter((c: unknown) => hasValue(c)).map((c: unknown) => String(c));
    if (codes.length) lines.push(`- **班次**: ${codes.join('、')}`);
  }
  if (hasValue(ft.goToWorkStartTime) || hasValue(ft.goOffWorkEndTime)) {
    const s = hasValue(ft.goToWorkStartTime) ? String(ft.goToWorkStartTime) : '?';
    const e = hasValue(ft.goOffWorkEndTime) ? String(ft.goOffWorkEndTime) : '?';
    const nextDay = /次日/.test(String(ft.goOffWorkTimeType ?? '')) ? '次日 ' : '';
    lines.push(`- **上下班时间**: ${s} - ${nextDay}${e}`);
  }

  // 固定/组合排班的可排时段（dayWorkTime.combinedArrangement，新结构不带星期）
  const combinedArrangement = asRecordArray(day.combinedArrangement);
  if (combinedArrangement.length > 0) {
    const caLines: string[] = [];
    combinedArrangement.forEach((ca, idx: number) => {
      if (!isNonEmpty(ca)) return;
      const s = hasValue(ca.combinedArrangementStartTime)
        ? String(ca.combinedArrangementStartTime)
        : '?';
      const e = hasValue(ca.combinedArrangementEndTime)
        ? String(ca.combinedArrangementEndTime)
        : '?';
      caLines.push(`  - 时段 ${idx + 1}: ${s} - ${e}`);
    });
    if (caLines.length) {
      lines.push(`- **可排时段**:`);
      lines.push(...caLines);
    }
  }

  // 自由文本（休息说明/工时备注）——新结构未必下发，存在则保留（自由文本优先于结构化字段）。
  pushLongText(lines, '休息说明', wt.restTimeDesc);
  pushLongText(lines, '工时备注', sanitizeConstraintText(asString(wt.workTimeRemark)));

  // 全周强排班提示：文本命中（做六休一/固定排班...）或结构化每周出勤≥5 天。
  const weeklyWorkDays = cleanNumber(wm.perWeekWorkDays);
  const structuralRigid = typeof weeklyWorkDays === 'number' && weeklyWorkDays >= 5;
  if (structuralRigid || hasFullWeekOrRigidSchedule(lines)) {
    lines.push(
      '- **排班硬约束提示**: "每天/做六休一/周一至周日/固定排班"表示工作日也要配合；候选人只做周末、每周最多几天、做一休一、下班后或只做晚班时，不能把该岗位说成"周末能排"或"晚班能排"。',
    );
  }

  return lines.length ? '### 工作时间\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 模块 6：面试流程 ====================

/**
 * 格式化面试时段，过滤海绵的 00:00 占位值。
 *
 * 现网大量岗位的 interviewStartTime/EndTime 是占位 "00:00"（表示"当天任意时段/以沟通为准"），
 * 直接渲染会得到 "00:00-00:00" 这类误导信息。起止均为占位（空/00:00）时返回空串，由调用方决定不渲染时段。
 */
function formatInterviewTimeRange(start: unknown, end: unknown): string {
  const s = hasValue(start) ? String(start).trim() : '';
  const e = hasValue(end) ? String(end).trim() : '';
  const isPlaceholder = (v: string) => v === '' || v === '00:00';
  if (isPlaceholder(s) && isPlaceholder(e)) return '';
  if (s && e) return `${s}-${e}`;
  return s || e;
}

function renderInterviewRound(
  roundInput: unknown,
  roundLabel: string,
  wayField: string,
  addressField: string,
  demandField: string,
  descField?: string,
): string[] {
  const round = asRecord(roundInput);
  if (!round || !isNonEmpty(round)) return [];
  const sub: string[] = [];
  pushField(sub, '面试方式', round[wayField]);
  pushField(sub, '面试地址', round[addressField]);
  // demand 可能含过期时效约束，统一清洗
  pushField(sub, '面试要求', sanitizeConstraintText(asString(round[demandField])));
  if (descField) pushLongText(sub, '说明', round[descField]);

  // 一面独有：时间模式 + 固定/周期面试时间
  if (roundLabel === '一轮面试') {
    pushField(sub, '时间模式', round.interviewTimeMode);

    const fixedInterviewTimes = asRecordArray(round.fixedInterviewTimes);
    if (fixedInterviewTimes.length > 0) {
      const fixedLines: string[] = [];
      fixedInterviewTimes.forEach((ft) => {
        if (!isNonEmpty(ft)) return;
        const date = hasValue(ft.interviewDate) ? String(ft.interviewDate) : '';
        const interviewTimes = asRecordArray(ft.interviewTimes);
        if (interviewTimes.length > 0) {
          interviewTimes.forEach((t) => {
            if (!isNonEmpty(t)) return;
            const range = formatInterviewTimeRange(t.interviewStartTime, t.interviewEndTime);
            // fixedDeadline 真实位置在每个 interviewTimes 项内（旧代码错读 round 顶层，恒空）。
            const deadline = hasValue(t.fixedDeadline) ? String(t.fixedDeadline) : '';
            let line = [date, range].filter(Boolean).join(' ').trim();
            if (deadline) line += `（报名截止: ${deadline}）`;
            if (line) fixedLines.push(`    - ${line}`);
          });
        } else if (date) {
          fixedLines.push(`    - ${date}`);
        }
      });
      if (fixedLines.length) {
        sub.push(`- **固定面试时间**:`);
        sub.push(...fixedLines);
      }
    }

    const periodicInterviewTimes = asRecordArray(round.periodicInterviewTimes);
    if (periodicInterviewTimes.length > 0) {
      const periodicLines: string[] = [];
      periodicInterviewTimes.forEach((pt) => {
        if (!isNonEmpty(pt)) return;
        const weekday = hasValue(pt.interviewWeekday) ? String(pt.interviewWeekday) : '';
        const interviewTimes = asRecordArray(pt.interviewTimes);
        if (interviewTimes.length > 0) {
          interviewTimes.forEach((t) => {
            if (!isNonEmpty(t)) return;
            const range = formatInterviewTimeRange(t.interviewStartTime, t.interviewEndTime);
            let line = [weekday, range].filter(Boolean).join(' ').trim();
            if (hasValue(t.cycleDeadlineDay) || hasValue(t.cycleDeadlineEnd)) {
              const dd = hasValue(t.cycleDeadlineDay) ? String(t.cycleDeadlineDay) : '';
              const de = hasValue(t.cycleDeadlineEnd) ? String(t.cycleDeadlineEnd) : '';
              const deadline = `${dd} ${de}`.trim();
              if (deadline) line += `（报名截止: ${deadline}）`;
            }
            if (line) periodicLines.push(`    - ${line}`);
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

function renderInterviewProcessSection(
  interviewProcessInput: unknown,
  policy: JobPolicyAnalysis,
): string {
  const ip = asRecord(interviewProcessInput);
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
      .map((item) => asRecord(item)?.interviewSupplement)
      .filter((s: unknown) => hasValue(s));
    if (items.length) lines.push(`- **面试补充项**: ${items.join('；')}`);
  }

  const probation = asRecord(ip.probationWork);
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

  const training = asRecord(ip.training);
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

function formatJobToOneLine(jobInput: unknown, index: number): string {
  const job = asRecord(jobInput) ?? {};
  const bi = asRecord(job.basicInfo) ?? {};
  const store = asRecord(bi.storeInfo) ?? {};
  const brandName = hasValue(bi.brandName) ? String(bi.brandName) : '';
  const jobName = hasValue(bi.jobName) ? String(bi.jobName) : '未命名';
  const parts = [`${index + 1}. **${brandName} - ${jobName}**`];
  const displayStoreName = normalizeStoreNameForAgent(
    asString(store.storeName),
    asString(store.storeCityName),
  );
  if (displayStoreName) parts.push(displayStoreName);
  if (hasValue(store.storeAddress)) parts.push(String(store.storeAddress));
  const distanceKm = asNumber(job._distanceKm);
  if (distanceKm != null) parts.push(`距离 ${distanceKm.toFixed(1)}km`);
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

function formatJobToMarkdown(
  jobInput: unknown,
  index: number,
  flags: ProgressiveDisclosureFlags,
): string {
  const job = asRecord(jobInput) ?? {};
  const bi = asRecord(job.basicInfo) ?? {};
  const policy = buildJobPolicyAnalysis(job as JobDetail);
  const jobName = hasValue(bi.jobName) ? String(bi.jobName) : '未命名岗位';
  const titleParts = [jobName];
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
    md += renderBasicInfoSection(job.basicInfo, asNumber(job._distanceKm));
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
  md += `- **jobId**: ${hasValue(bi.jobId) ? bi.jobId : '未知'}\n\n`;
  return md;
}

export function formatJobsToMarkdown(
  jobs: unknown[],
  total: number,
  pageNum: number,
  pageSize: number,
  flags: ProgressiveDisclosureFlags,
  brandGroups: BrandNearestStoresGroup[] | null = null,
): string {
  const start = (pageNum - 1) * pageSize + 1;
  const end = Math.min(start + jobs.length - 1, total);

  let md = `# 在招岗位（共 ${total} 个）\n\n`;

  md +=
    '> ⚠️ **数据使用原则**：各 section 中的备注、remark 等自由文本字段可能包含结构化字段未覆盖或与之矛盾的补充信息，回复时须结合全部内容，**自由文本与结构化字段冲突时以自由文本为准**\n\n';

  md += renderCandidateCardsBanner(jobs);

  // 同品牌多门店强约束置顶（同品牌两家被压缩成"有肯德基、肯德基"）
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
