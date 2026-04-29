/**
 * DuLiDay 岗位查询工具（LLM 优化版）
 *
 * 渐进式数据返回：通过 6 个布尔开关控制返回的数据字段。
 * 支持 markdown / rawData 两种输出格式。
 *
 * markdown 模式：对每个岗位按 6 个模块（基本信息/薪资/福利/招聘要求/
 * 工作时间/面试流程）进行"语义投影"——把原始 JSON 字段按业务语义
 * 合并成可读中文文本（value+unit 合并、min/max 区间合并、名称+ID、
 * 坐标、身高区间、排班多变体等），null/空值字段自动隐藏。
 *
 * 导出 buildJobListTool 供注册表使用
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import type { RecommendedJobSummary } from '@memory/types/session-facts.types';
import {
  sanitizeJobDisplayText,
  sanitizeLaborFormForDisplay,
  stripLaborFormFromCategories,
} from '@memory/facts/labor-form';
import { ToolBuilder } from '@shared-types/tool.types';
import {
  buildJobPolicyAnalysis,
  cleanPolicyText,
  sanitizeConstraintText,
  type JobPolicyAnalysis,
} from '@tools/duliday/job-policy-parser';

// ==================== 常量 ====================

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;
const DISTANCE_SCAN_MAX_PAGES = 10;
const EARTH_RADIUS_KM = 6371;

// ==================== 距离计算 ====================

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine 公式：计算两个经纬度之间的距离（km） */
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==================== 输入 Schema ====================

const inputSchema = z.object({
  cityNameList: z.array(z.string()).optional().default([]).describe('城市列表'),
  regionNameList: z.array(z.string()).optional().default([]).describe('区域列表'),
  brandAliasList: z.array(z.string()).optional().default([]).describe('品牌别名列表'),
  storeNameList: z.array(z.string()).optional().default([]).describe('门店名称列表（模糊匹配）'),
  jobCategoryList: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      '岗位工种/职位类目，描述这份岗位具体做什么工作。例如：["咖啡师"]、["服务员"]、["理货员"]、["分拣员"]、["收银员"]、["骑手"]。严禁填入"兼职"、"全职"、"小时工"、"寒假工"、"暑假工"、"兼职+"、"临时工"等用工形式词——平台所有岗位都是兼职岗位，用工形式不是岗位工种，若有用工形式偏好应用其他方式在结果中筛选。',
    ),
  brandIdList: z.array(z.number().int()).optional().default([]).describe('品牌ID列表'),
  projectNameList: z.array(z.string()).optional().default([]).describe('项目名称列表'),
  projectIdList: z.array(z.number().int()).optional().default([]).describe('项目ID列表'),
  jobIdList: z.array(z.number().int()).optional().default([]).describe('岗位ID列表'),

  location: z
    .object({
      longitude: z.number().optional().describe('经度（通过 geocode 工具或位置分享获取）'),
      latitude: z.number().optional().describe('纬度（通过 geocode 工具或位置分享获取）'),
      range: z.number().int().optional().describe('位置筛选范围，单位米'),
    })
    .optional()
    .describe('位置筛选条件'),

  responseFormat: z
    .array(z.enum(['markdown', 'rawData']))
    .optional()
    .default(['markdown'])
    .describe('返回格式，可多选。默认 ["markdown"]'),

  includeBasicInfo: z.boolean().optional().default(true).describe('返回基本信息 - 默认true'),
  // 默认 true 的两类（badcase #15 北京必胜客日结/月结、#22 六姐没主动报薪）：
  // - includeJobSalary：薪资是候选人最关心的事实，缺薪资的推荐易被竞品挖走；阶梯
  //   薪资和发薪周期（日结/月结）也都靠这个开关返回。默认 false 时模型常忘开。
  // - includeHiringRequirement：首次推荐就该让候选人看到关键要求自行判断（已在
  //   prompt 写明），默认 false 等于把"模型记得开"当兜底，不可靠。
  includeJobSalary: z.boolean().optional().default(true).describe('返回薪资信息 - 默认true'),
  includeWelfare: z.boolean().optional().default(false).describe('返回福利信息'),
  includeHiringRequirement: z
    .boolean()
    .optional()
    .default(true)
    .describe('返回招聘要求 - 默认true'),
  includeWorkTime: z.boolean().optional().default(false).describe('返回工作时间/班次'),
  includeInterviewProcess: z.boolean().optional().default(false).describe('返回面试流程'),
});

// ==================== 通用工具函数 ====================

interface ProgressiveDisclosureFlags {
  includeBasicInfo: boolean;
  includeJobSalary: boolean;
  includeWelfare: boolean;
  includeHiringRequirement: boolean;
  includeWorkTime: boolean;
  includeInterviewProcess: boolean;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 更严格的空值判断：递归看对象/数组里是否有任何有效字段 */
function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(isNonEmpty);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(isNonEmpty);
  }
  return true;
}

function normalizeKeyword(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function scoreJobAgainstRequestedCategories(job: any, jobCategoryList: string[]): number {
  const requestedKeywords = jobCategoryList.map((item) => normalizeKeyword(item)).filter(Boolean);

  if (requestedKeywords.length === 0) return 0;

  const searchableFields = [
    job.basicInfo?.jobCategoryName,
    job.basicInfo?.jobName,
    job.basicInfo?.jobNickName,
    job.basicInfo?.jobContent,
  ]
    .map((value) => normalizeKeyword(typeof value === 'string' ? value : ''))
    .filter(Boolean);

  if (searchableFields.length === 0) return 0;

  let score = 0;

  for (const keyword of requestedKeywords) {
    for (const field of searchableFields) {
      if (field === keyword) {
        score += 10;
        continue;
      }
      if (field.includes(keyword) || keyword.includes(field)) {
        score += 6;
        continue;
      }
      if (keyword.length >= 4 && field.length >= 4) {
        const overlap = Array.from(new Set(keyword)).filter((char) => field.includes(char)).length;
        if (overlap >= 3) score += 2;
      }
    }
  }

  return score;
}

function filterJobsByRequestedCategories(jobs: any[], jobCategoryList: string[]): any[] {
  return jobs
    .map((job) => ({ job, score: scoreJobAgainstRequestedCategories(job, jobCategoryList) }))
    .filter(({ score }) => score >= 6)
    .sort((a, b) => b.score - a.score)
    .map(({ job }) => job);
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ==================== 文本清洗 ====================

/** 单行文本清洗：保留原行内容，仅做噪音短语剔除（不替换换行） */
function cleanSingleLineText(text: string): string {
  if (!text) return '';
  return text
    .replace(/辛苦跟.*?[。！？]/g, '')
    .replace(/务必.*?[。！？]/g, '')
    .replace(/手动输入/g, '')
    .replace(/！{2,}/g, '！')
    .trim();
}

/** 多行文本清洗：保留换行结构，逐行 trim，剔除首尾空行 */
function cleanMultilineText(text: string): string {
  if (!text) return '';
  const cleaned = text
    .replace(/辛苦跟.*?[。！？]/g, '')
    .replace(/务必.*?[。！？]/g, '')
    .replace(/手动输入/g, '')
    .replace(/！{2,}/g, '！')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  const lines = cleaned.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

// ==================== 投影渲染 helpers ====================

/** 把 `- **label**: value` 推入行数组；value 为空时跳过 */
function pushField(
  lines: string[],
  label: string,
  value: string | number | null | undefined,
): void {
  if (value === null || value === undefined) return;
  let text: string;
  if (typeof value === 'number') {
    text = String(value);
  } else if (typeof value === 'string') {
    const cleaned = cleanSingleLineText(value);
    if (!cleaned) return;
    text = cleaned;
  } else {
    return;
  }
  lines.push(`- **${label}**: ${text}`);
}

/** 推入长文本字段，保留原始换行，多行时换行后缩进 2 格 */
function pushLongText(lines: string[], label: string, text: string | null | undefined): void {
  if (!text || typeof text !== 'string') return;
  const cleaned = cleanMultilineText(text);
  if (!cleaned) return;
  const rawLines = cleaned.split(/\r?\n/);
  if (rawLines.length === 1) {
    lines.push(`- **${label}**: ${rawLines[0]}`);
    return;
  }
  lines.push(`- **${label}**:`);
  for (const line of rawLines) {
    lines.push(`  ${line}`);
  }
}

/** 数值整形：去掉无意义的 .0 小数 */
function cleanNumber(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null;
    return Number.isInteger(value) ? value : Number(value.toFixed(2));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isNaN(n)) {
      return Number.isInteger(n) ? n : Number(n.toFixed(2));
    }
    return trimmed;
  }
  return null;
}

/** 合并 value + unit：24 + 元/时 → "24 元/时" */
function formatValueWithUnit(value: unknown, unit: unknown): string | null {
  const cleaned = cleanNumber(value);
  if (cleaned === null) return null;
  const u = hasValue(unit) ? ` ${String(unit).trim()}` : '';
  return `${cleaned}${u}`;
}

/** 合并 min/max/unit 区间：150,200,元/天 → "150-200 元/天" */
function formatRange(min: unknown, max: unknown, unit: unknown): string | null {
  const minVal = cleanNumber(min);
  const maxVal = cleanNumber(max);
  if (minVal === null && maxVal === null) return null;
  const minStr = minVal === null ? '?' : String(minVal);
  const maxStr = maxVal === null ? '?' : String(maxVal);
  const u = hasValue(unit) ? ` ${String(unit).trim()}` : '';
  if (minStr === maxStr) return `${minStr}${u}`;
  return `${minStr}-${maxStr}${u}`;
}

/** 合并名称+ID：品牌=肯德基 + id=10005 → "肯德基 (ID: 10005)" */
function formatNameWithId(name: unknown, id: unknown): string | null {
  if (!hasValue(name)) return null;
  if (!hasValue(id)) return String(name);
  return `${String(name).trim()} (ID: ${id})`;
}

/** 合并时间段：两端都有 → "22:00 - 23:00"；只有一端 → "22:00 起" / "至 23:00" */
function formatTimeRange(start: unknown, end: unknown): string {
  const s = hasValue(start) ? String(start).trim() : null;
  const e = hasValue(end) ? String(end).trim() : null;
  if (s && e) return `${s} - ${e}`;
  if (s) return `${s} 起`;
  if (e) return `至 ${e}`;
  return '';
}

/** 压缩星期列表：每周一至每周日全齐 → "每天"；否则原样以逗号分隔 */
function compressWeekdays(days: string): string {
  if (!days) return '';
  const tokens = days
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 7) {
    const full = ['每周一', '每周二', '每周三', '每周四', '每周五', '每周六', '每周日'];
    if (full.every((d) => tokens.includes(d))) return '每天';
  }
  return tokens.join(', ');
}

function hasFullWeekOrRigidSchedule(lines: string[]): boolean {
  const text = lines.join('\n');
  return /每天|周一至周日|做六休一|固定排班|05:00\s*-\s*23:00|早开晚结/.test(text);
}

// ==================== 约面重点（policy 汇总）====================

function addSummaryLine(lines: string[], label: string, value: string | null | undefined): void {
  if (hasValue(value) && typeof value === 'string') {
    const cleaned = cleanPolicyText(value);
    if (cleaned) lines.push(`- **${label}**: ${cleaned}`);
  } else if (hasValue(value)) {
    lines.push(`- **${label}**: ${value}`);
  }
}

function formatInterviewDecisionSummary(policy: JobPolicyAnalysis): string {
  const lines: string[] = [];

  if (policy.normalizedRequirements.ageRequirement !== '不限') {
    addSummaryLine(lines, '年龄要求', policy.normalizedRequirements.ageRequirement);
  }

  if (policy.normalizedRequirements.healthCertificateRequirement !== '未明确要求') {
    addSummaryLine(lines, '健康证', policy.normalizedRequirements.healthCertificateRequirement);
  }

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
  const storeLine = formatNameWithId(store.storeName, store.storeId);
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
  return '### 薪资信息\n' + blocks.join('') + '\n';
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
  if (store?.storeName) parts.push(store.storeName);
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

  if (flags.includeHiringRequirement || flags.includeInterviewProcess) {
    md += formatInterviewDecisionSummary(policy);
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

function formatJobsToMarkdown(
  jobs: any[],
  total: number,
  pageNum: number,
  pageSize: number,
  flags: ProgressiveDisclosureFlags,
): string {
  const start = (pageNum - 1) * pageSize + 1;
  const end = Math.min(start + jobs.length - 1, total);

  let md = `# 在招岗位（共 ${total} 个）\n\n`;

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

// ==================== 薪资摘要（供 RecommendedJobSummary 使用）====================

function formatSalarySummary(job: any): string | null {
  const salary = job.jobSalary;
  if (!salary) return null;

  const scenario = salary.salaryScenarioList?.[0];
  if (scenario) {
    const comp = scenario.comprehensiveSalary;
    if (comp && (comp.minComprehensiveSalary != null || comp.maxComprehensiveSalary != null)) {
      return `${comp.minComprehensiveSalary ?? '?'}-${comp.maxComprehensiveSalary ?? '?'} ${comp.comprehensiveSalaryUnit || '元/月'}`;
    }
    const basic = scenario.basicSalary;
    if (basic?.basicSalary != null) {
      return `${basic.basicSalary}${basic.basicSalaryUnit || '元'}`;
    }
  }

  const probation = salary.probationSalary;
  if (probation?.salary != null) {
    return `${probation.salary}${probation.salaryUnit || '元'}（试工期）`;
  }
  return null;
}

function inferStudentRequirement(policy: JobPolicyAnalysis): string | null {
  const text = [
    policy.normalizedRequirements.remark,
    policy.normalizedRequirements.interviewRemark,
    policy.interviewMeta.demand,
    ...policy.highlights.requirementHighlights,
  ]
    .filter((item): item is string => Boolean(item && item.trim()))
    .join('；');
  if (!text) return null;

  const normalized = text.replace(/\s+/g, '');
  if (/(不招学生|学生勿扰|学生不考虑|仅限非学生|非学生优先|需要已毕业)/.test(normalized)) {
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

/**
 * 同品牌"最近门店"汇总：候选人在某区域有 brand intent 时，
 * 如果同品牌返回多家门店，必须按品牌分组挑距离最近的 1-2 家展示，
 * 否则容易跳过更近的同品牌门店推荐更远的（badcase 70xxcmhy）。
 */
function buildBrandNearestStoreSummary(jobs: any[]): Array<{
  brandName: string;
  brandId: number | null;
  nearestStores: Array<{ storeName: string | null; jobId: number; distanceKm: number | null }>;
}> | null {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;

  const buckets = new Map<
    string,
    {
      brandName: string;
      brandId: number | null;
      stores: Array<{ storeName: string | null; jobId: number; distanceKm: number | null }>;
    }
  >();

  for (const job of jobs) {
    const brandName = job.basicInfo?.brandName;
    if (!brandName || typeof brandName !== 'string') continue;
    const brandId = typeof job.basicInfo?.brandId === 'number' ? job.basicInfo.brandId : null;
    const jobId = typeof job.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null;
    if (jobId == null) continue;
    const key = `${brandName}__${brandId ?? 'null'}`;
    const bucket = buckets.get(key) ?? { brandName, brandId, stores: [] };
    bucket.stores.push({
      storeName: job.basicInfo?.storeInfo?.storeName ?? job.basicInfo?.storeName ?? null,
      jobId,
      distanceKm:
        typeof job._distanceKm === 'number' ? Math.round(job._distanceKm * 10) / 10 : null,
    });
    buckets.set(key, bucket);
  }

  const summary = Array.from(buckets.values())
    .filter((bucket) => bucket.stores.length >= 1)
    .map((bucket) => ({
      brandName: bucket.brandName,
      brandId: bucket.brandId,
      nearestStores: bucket.stores
        .slice()
        .sort((a, b) => {
          if (a.distanceKm == null && b.distanceKm == null) return 0;
          if (a.distanceKm == null) return 1;
          if (b.distanceKm == null) return -1;
          return a.distanceKm - b.distanceKm;
        })
        .slice(0, 3),
    }));

  return summary.length > 0 ? summary : null;
}

function mapJobsToSummaries(jobs: any[]): RecommendedJobSummary[] {
  return jobs.map((job) => {
    const policy = buildJobPolicyAnalysis(job);
    const ageRequirement = policy.normalizedRequirements.ageRequirement;
    const educationRequirement = policy.normalizedRequirements.educationRequirement;
    const healthCertificateRequirement = policy.normalizedRequirements.healthCertificateRequirement;

    return {
      jobId: job.basicInfo.jobId,
      brandName: job.basicInfo.brandName ?? null,
      jobName: job.basicInfo.jobName ?? null,
      storeName: job.basicInfo.storeInfo?.storeName ?? null,
      storeAddress: job.basicInfo.storeInfo?.storeAddress ?? null,
      cityName: job.basicInfo.storeInfo?.storeCityName ?? null,
      regionName: job.basicInfo.storeInfo?.storeRegionName ?? null,
      laborForm: job.basicInfo.laborForm ?? null,
      salaryDesc: formatSalarySummary(job),
      jobCategoryName: job.basicInfo.jobCategoryName ?? null,
      ageRequirement: ageRequirement && ageRequirement !== '不限' ? ageRequirement : null,
      educationRequirement:
        educationRequirement && educationRequirement !== '不限' ? educationRequirement : null,
      healthCertificateRequirement:
        healthCertificateRequirement && healthCertificateRequirement !== '未明确要求'
          ? healthCertificateRequirement
          : null,
      studentRequirement: inferStudentRequirement(policy),
      distanceKm: job._distanceKm != null ? Math.round(job._distanceKm * 10) / 10 : null,
    };
  });
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ==================== 构建函数 ====================

const logger = new Logger('duliday_job_list');

const DESCRIPTION = `查询在招岗位列表。支持渐进式数据返回，按需获取岗位信息。

## 适用场景
- 候选人在问品牌、岗位、门店、距离、工资、排班、要求、福利、面试流程
- 你需要校验候选人刚提到的品牌、门店或岗位是否真实在招
- 你要回答"某品牌在某城市/区域有岗、没岗、最近在哪个区有岗"这类分布判断

## 检索机制（必读）
- 后端只做关键字精确匹配，**不做语义理解、不做拼写纠正、不做模糊改写**
- 传入的字段值必须命中数据库真实字符串，否则直接返回 0 条；与"该候选人意向不存在"完全不是一回事
- "上海大宁音乐广场店" 这种带城市前缀的口语化门店名很可能匹配不上真实门店名

## 筛选字段稳定性分级（决定该选哪个 filter）
- **高稳定（首选）**：jobIdList / brandIdList / projectIdList（数字主键，命中率最高）
- **中稳定**：cityNameList / regionNameList（标准行政区划，几乎不会拼错）
- **低稳定（易踩坑）**：storeNameList / projectNameList / brandAliasList（用户口语 vs 数据库实名常对不上）
- 选 filter 时 **从高稳定到低稳定**：能用 jobIdList 就不用 storeNameList；能用 regionNameList 拿候选集再筛门店，就不要直接 storeNameList

## 查询路径模板（覆盖 90% 场景）

| 用户场景 | 标准查询路径 |
| --- | --- |
| 问某具体岗位详情 | 优先 jobIdList 直查，不叠加其他 filter |
| 问"某区域有什么" | cityNameList + regionNameList，按需补 jobCategoryList / brandIdList |
| 问"附近有什么" / 给了商圈/地标 | 先 geocode 拿坐标 → 传 location 半径；若结果 ≤ 1 条**必须**去掉 location 重查全市 |
| 用户接受了某门店但要换条件 | **先在 [会话记忆] 里查这门店所在的 region**，用 regionNameList 重查；不要直接拿口语门店名传 storeNameList |
| 用户问"还有别的品牌吗" | **不带 brandIdList 重查**当前区域，对比之前已展示的 brand 集合，告诉用户除了已推过的还有什么 |

## 结果数处理（必须遵守）
- **0 条**：本次查询失败。检查是否用了 storeNameList / brandAliasList 等低稳定字段；若是，立即换成 regionNameList / brandIdList 重试一次；若已经是稳定字段且仍为 0，**如实告知候选人"暂时没找到"**，不要再换条件硬试
- **1 条** 且候选人在问"还有别的吗 / 什么品牌 / 其他选择"：把这视为反常信号，**必须再放宽 1 个维度重查**——去掉 location，或扩大半径到全市，或去掉某个 brand/category filter。直接用 1 条结果回答"暂时没空缺"是错误的
- **≥ 2 条**：可以基于结果回复，无需扩面
- **同一轮内本工具调用次数硬上限 = 3**：第 4 次系统会直接拒绝。第 3 次仍未拿到可用数据时，应基于已有结果如实告知候选人，不要再继续猜 filter

## 必须考虑的硬约束
- 本轮 system prompt 中若出现 [本轮查询硬约束] 段落，列出的字段都要在本轮查询里体现——要么作为 filter 参数，要么打开对应 include 开关后在结果集中自行排除
- 硬约束清单里每一项会注明如何处理（例如「填到 cityNameList」「开 includeHiringRequirement」等），以该注释为准；注释里没说"填到 XxxList"的字段不要硬塞进 filter
- 缺少任一硬约束的查询结果不得用于"该候选人场景下无空缺"的结论
- 候选人说"只周末"、"平时下班后"、"只能晚班"、"每周最多两天"、"做一休一"、"不上夜班"、"周四最早 19:30"这类班次/出勤限制时，必须把工作时间当硬约束；岗位结果里的"每天"、"周一至周日"、"做六休一"、"每周四/六/日都要给班"、"早开晚结全天时段/05:00-23:00"表示强排班要求，不能解释成任选一天、任选晚班或可只做周末
- "只周末/纯周末/每周最多两天/做一休一"都是比"每天/做六休一"更窄的约束；除非岗位明确写着"只周末/仅周末/可只排周末/每周可两天/可做一休一"，否则看到"每天/周一至周日/做六休一"必须视为不匹配，不得回复"周末能排"或"可以协调"

## 参数要点
- 至少提供一个有效筛选条件：城市、区域、品牌、门店、岗位类型、项目ID、岗位ID。根据 [会话记忆] 中候选人意向填入
- responseFormat 只能用 ["markdown"]，禁止 rawData
- 传 regionNameList 时必须同时传 cityNameList；系统已有高置信城市时直接使用，否则先追问城市
- 行政区域（静安区/浦东新区等）可直接查岗；商圈/地标/街道/详细地址（人民广场/陆家嘴/XX路123号等）**不得**直接当 regionNameList，需先 geocode 或使用位置分享坐标
- **未确认城市禁默认**：[本轮高置信线索] 与 [会话记忆] 都未给出城市时，禁止默认任何城市做查岗或品牌承诺；候选人明确品牌但未给城市时，必须先简短确认"您想找哪个城市的岗位"，避免出现把"北京必胜客"默认按上海查的事故

## 按候选人当前问题精确开启数据开关（不要全部打开）

| 候选人当前在问什么                   | 开启的开关                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| 哪些门店、哪里近、位置方便吗         | 先 geocode，再把城市/区域/品牌连同 location.longitude / location.latitude 一起传；需要 10km / 5km 内筛选时补 location.range |
| 工资多少、薪资怎么样                 | includeJobSalary                                                              |
| 怎么排班、上班时间、能不能兼职       | includeWorkTime                                                               |
| 有什么要求、我符不符合、要不要健康证 | includeHiringRequirement                                                      |
| 福利待遇、包吃住、补贴政策           | includeWelfare                                                                |
| 怎么面试、什么时候面试、面试流程     | includeInterviewProcess                                                       |

## 回复展示要求
- 推荐 2 个及以上岗位时，每个岗位必须单独成行或成段，至少保留门店/岗位、核心薪资或时段、关键要求；禁止把多个岗位压缩在同一句中用顿号、逗号或"。、"串起来
- 多个岗位同品牌时，必须用门店名、区域/地址或距离把它们区分开；不能只说"有奥乐齐/肯德基"让候选人分不清是哪家
- **薪资必须主动展示**：本轮要做具体岗位推荐时，每条岗位都必须带上薪资数字/范围；工具返回阶梯薪资字段时，必须保留基础薪资 + 阶梯规则原文（如"基础 25/小时，做满 4 小时再加 5"），禁止简化为"约 X 元"或只说基础时薪。候选人没问也要给薪资，不主动给薪资容易让候选人转去竞品
- **挑选式开场禁忌**：直接展示 1~2 个最匹配岗位的完整详情，不要先发"有 A/B/C 三个岗位/门店你想看哪个"再等候选人选；候选人挑选式开场容易直接放弃
- 工作内容里出现"清洗灶台/打荷/收档/拖盘/出货"等行业短语时，必须用一句口语化解释展开，让候选人明白具体做什么；不要原样复读简短关键词

## 硬规则
- **品牌/区域分布判断必须基于本工具结果**：候选人说出品牌不得用"XX是吧"直接确认，需先在当前已知范围验证在招；"杨浦没岗、虹口有岗"这类分布结论也必须先查。未查前只能说"我先帮你查下"
- **具体岗位/门店推荐必须带位置**：候选人给了商圈/地标/街道/详细地址/位置分享/经纬度等具体位置线索、且本轮要输出具体岗位或门店推荐时，必须先 geocode 或使用位置分享经纬度再调用本工具；不要因对方没明说"附近/离我近"就跳过。学校、校区、学院、小学部等地点名只代表位置，不代表学历
- **推荐距离是硬约束**：只要本轮在推荐具体岗位/门店，结果必须满足业务距离阈值；超出阈值即使其他条件匹配也不得推荐。无有效 location 时只能回答在招情况或区域分布，不得输出具体推荐
- **同品牌按距离最近优先**：候选人有 brand intent 时（明确说出品牌名 / 反复指代某品牌），先看 queryMeta.brandNearestStores 同品牌最近门店列表；同品牌返回多家时，必须按 brandNearestStores 的距离升序展示，不得跳过更近的同品牌门店转推更远的同品牌门店
- **明确品牌意向时不静默换品牌**：候选人明确说出"找成都你六姐 / 我想去肯德基"时，brand 必须进 brandIdList；该品牌在范围内 0 条岗位时，先告知"暂时没有 X 品牌的岗位"，再询问是否看其他品牌，不得默默换成其他品牌推荐
- **工时长度反查**：候选人说"时间长一点的 / 工时长 / 全天班 / 想做半天以上"等工时偏好时，必须开 includeWorkTime=true 并基于工作时间字段重新筛选；若结果集仍以短班为主，先告知"附近主要是短班"再问是否扩大区域，不要继续把短班包装成"差不多"
- **首次推荐必须开 includeHiringRequirement**，把关键要求随岗位信息一起告知让候选人自行判断；严禁推完岗位再逐个追问个人条件去做比对
- **无岗时的动作链**：候选人范围内 0 条结果时，按以下顺序收口：
   1. 第一次 0 条 → 在合理范围内放宽一次（同城邻区 / 同品牌邻店 / 放宽距离阈值），且本轮直接执行放宽查询，不向候选人多问一句
   2. 放宽后仍 0 条 = "无替代"，必须直接告知候选人"暂时没有合适岗位"并调用 invite_to_group 拉群维护
   3. 严禁继续反问候选人"那别的区域 / 别的品牌 / 别的城市看看吗"；候选人主动表达扩张意愿前不再继续扩查，否则会陷入"反复问位置→反复无岗"的空转
- **包餐/工作餐/餐补硬偏好**：候选人说"没饭吃不去了 / 拉倒了 / 不考虑 / 必须包饭"等，视为硬性拒绝或强偏好；不要安慰成"附近吃饭方便"，也不要继续收面试资料。若要继续推荐，必须本轮调用本工具且带 includeWelfare=true 查包餐/餐补/福利信息；没有匹配就说明暂时没有合适的包餐岗位，并调用 invite_to_group 维护
- **面试相关字段**：推进面试时优先读工具结果中的「约面重点」；工具没明确时间不得编造；相对当前时间已过期的日期限制视为历史备注，不得当作当前规则输出

## 空头承诺禁忌
- 工具未返回某福利字段（工作餐/包餐/餐补/班车/补贴等）时，不得说"有 / 没有 该福利"；只能说"这个我再帮你确认下"
- 阶梯薪资必须保留基础时薪 + 阶梯规则原文（例如"基础 25/小时，做满 4 小时再加 5"），禁止简化为"约 X 元"或"固定 X 元/小时"
- 历史助手回复说过的门店事实不能当本轮事实复述；本轮要给候选人新的具体推荐时，必须以本轮工具结果为准；只有 [当前焦点岗位] 等记忆字段是稳定的，可以直接承接`;

export function buildJobListTool(spongeService: SpongeService): ToolBuilder {
  return (context) => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({
        cityNameList = [],
        regionNameList = [],
        brandAliasList = [],
        brandIdList = [],
        projectNameList = [],
        projectIdList = [],
        storeNameList = [],
        jobCategoryList = [],
        jobIdList = [],
        location,
        responseFormat = ['markdown'],
        includeBasicInfo = true,
        includeJobSalary = true,
        includeWelfare = false,
        includeHiringRequirement = true,
        includeWorkTime = false,
        includeInterviewProcess = false,
      }) => {
        const normalizedCityNameList = cityNameList.map((city) => city.trim()).filter(Boolean);
        const normalizedRegionNameList = regionNameList
          .map((region) => region.trim())
          .filter(Boolean);

        if (normalizedRegionNameList.length > 0 && normalizedCityNameList.length === 0) {
          return { error: '需要城市信息，只有区，无法查询' };
        }

        // 兜底：剔除 jobCategoryList 中的用工形式词（兼职/全职/小时工/寒假工/暑假工 等）。
        // 平台所有岗位都是兼职岗位，用工形式不是岗位工种，不应作为 category 查询条件。
        const { cleaned: sanitizedJobCategoryList, removed: removedCategoryWords } =
          stripLaborFormFromCategories(jobCategoryList);
        if (removedCategoryWords.length > 0) {
          logger.warn(
            `jobCategoryList 兜底剔除用工形式词: ${removedCategoryWords.join('、')}（原始: ${JSON.stringify(jobCategoryList)}）`,
          );
        }

        const options = {
          includeBasicInfo,
          includeJobSalary,
          includeWelfare,
          includeHiringRequirement,
          includeWorkTime,
          includeInterviewProcess,
        };
        const fetchBaseParams = {
          cityNameList: normalizedCityNameList,
          regionNameList: normalizedRegionNameList,
          brandAliasList,
          brandIdList,
          projectNameList,
          projectIdList,
          storeNameList,
          jobCategoryList: sanitizedJobCategoryList,
          jobIdList,
          location,
          options,
        };
        try {
          let storeMatchStrategy: 'api_exact' | 'local_fuzzy_match' = 'api_exact';
          let jobCategoryMatchStrategy: 'api_exact' | 'local_keyword_match' = 'api_exact';
          let distanceScanPages = 1;
          let distanceScanTruncated = false;

          // 首次请求
          let { jobs, total } = await spongeService.fetchJobs(fetchBaseParams);

          // 门店名模糊匹配回退
          if (jobs.length === 0 && storeNameList.length > 0) {
            const fallback = await spongeService.fetchJobs({ options });
            if (fallback.jobs.length > 0) {
              /* eslint-disable @typescript-eslint/no-explicit-any */
              const lowerKeywords = storeNameList.map((s) => s.toLowerCase());
              const filtered = fallback.jobs.filter((job: any) => {
                const storeName = (job.basicInfo?.storeInfo?.storeName || '').toLowerCase();
                return lowerKeywords.some((kw) => storeName.includes(kw));
              });
              /* eslint-enable @typescript-eslint/no-explicit-any */
              if (filtered.length > 0) {
                storeMatchStrategy = 'local_fuzzy_match';
                jobs = filtered;
                total = filtered.length;
              }
            }
          }

          // 岗位类型本地兜底：当 API 对岗位类型检索不稳定时，退回到同条件宽查后，
          // 仅基于真实岗位字段做本地匹配，不依赖手写别名字典。
          if (jobs.length === 0 && sanitizedJobCategoryList.length > 0) {
            const fallback = await spongeService.fetchJobs({
              cityNameList: normalizedCityNameList,
              regionNameList: normalizedRegionNameList,
              brandAliasList,
              brandIdList,
              projectNameList,
              projectIdList,
              storeNameList,
              jobIdList,
              options,
            });

            /* eslint-disable @typescript-eslint/no-explicit-any */
            const filtered = filterJobsByRequestedCategories(
              fallback.jobs as any[],
              sanitizedJobCategoryList,
            );
            /* eslint-enable @typescript-eslint/no-explicit-any */
            if (filtered.length > 0) {
              jobCategoryMatchStrategy = 'local_keyword_match';
              jobs = filtered;
              total = filtered.length;
            }
          }

          // 距离计算 + 阈值过滤
          const locationLatitude = location?.latitude;
          const locationLongitude = location?.longitude;
          const hasUserCoords = locationLatitude != null && locationLongitude != null;
          const distanceThreshold = context.thresholds?.find(
            (t) => t.flag === 'max_recommend_distance_km',
          );
          const maxKm = distanceThreshold?.max;

          // 关键优化：在距离过滤前补抓后续页，避免“第一页只有1条近距离岗位”
          if (hasUserCoords && maxKm != null && total > jobs.length) {
            const totalPages = Math.ceil(total / DEFAULT_PAGE_SIZE);
            const maxPagesToScan = Math.min(totalPages, DISTANCE_SCAN_MAX_PAGES);
            distanceScanTruncated = maxPagesToScan < totalPages;

            if (maxPagesToScan > 1) {
              const mergedJobs = [...jobs];
              const seenJobIds = new Set<number>();
              for (const job of mergedJobs) {
                const jobId = job?.basicInfo?.jobId;
                if (typeof jobId === 'number') seenJobIds.add(jobId);
              }

              for (let pageNum = 2; pageNum <= maxPagesToScan; pageNum += 1) {
                const pageResult = await spongeService.fetchJobs({
                  ...fetchBaseParams,
                  pageNum,
                  pageSize: DEFAULT_PAGE_SIZE,
                });
                distanceScanPages = pageNum;

                if (!pageResult.jobs.length) break;
                for (const job of pageResult.jobs) {
                  const jobId = job?.basicInfo?.jobId;
                  if (typeof jobId === 'number') {
                    if (seenJobIds.has(jobId)) continue;
                    seenJobIds.add(jobId);
                  }
                  mergedJobs.push(job);
                }
              }

              jobs = mergedJobs;
              total = mergedJobs.length;
            }
          }

          if (hasUserCoords) {
            /* eslint-disable @typescript-eslint/no-explicit-any */
            for (const job of jobs as any[]) {
              const store = job.basicInfo?.storeInfo;
              if (store?.latitude != null && store?.longitude != null) {
                job._distanceKm = haversineDistance(
                  locationLatitude!,
                  locationLongitude!,
                  Number(store.latitude),
                  Number(store.longitude),
                );
              }
            }

            if (maxKm != null) {
              const beforeCount = jobs.length;
              jobs = (jobs as any[]).filter(
                (job) => job._distanceKm == null || job._distanceKm <= maxKm,
              );
              total = jobs.length;
              if (beforeCount > 0 && jobs.length === 0) {
                return {
                  error: `附近 ${maxKm}km 内没有符合条件的岗位，可以尝试扩大搜索范围`,
                };
              }
            }

            // 按距离排序（有坐标的在前，无坐标的在后）
            (jobs as any[]).sort((a, b) => {
              if (a._distanceKm == null && b._distanceKm == null) return 0;
              if (a._distanceKm == null) return 1;
              if (b._distanceKm == null) return -1;
              return a._distanceKm - b._distanceKm;
            });
            /* eslint-enable @typescript-eslint/no-explicit-any */
          }

          if (jobs.length === 0) {
            return { error: '未找到符合条件的岗位' };
          }

          const flags: ProgressiveDisclosureFlags = {
            includeBasicInfo,
            includeJobSalary,
            includeWelfare,
            includeHiringRequirement,
            includeWorkTime,
            includeInterviewProcess,
          };

          const formatSet = new Set(responseFormat);
          const result: Record<string, unknown> = {};

          if (formatSet.has('markdown')) {
            result.markdown = formatJobsToMarkdown(
              jobs,
              total,
              DEFAULT_PAGE_NUM,
              DEFAULT_PAGE_SIZE,
              flags,
            );
          }
          if (formatSet.has('rawData')) {
            result.rawData = { result: jobs, total };
          }
          result.queryMeta = {
            storeMatchStrategy,
            jobCategoryMatchStrategy,
            usedDistanceFiltering: hasUserCoords,
            distanceThresholdKm: maxKm ?? null,
            distanceScanPages,
            distanceScanTruncated,
            brandNearestStores: hasUserCoords ? buildBrandNearestStoreSummary(jobs) : null,
          };

          // 通知调用方已获取岗位数据
          if (context.onJobsFetched && jobs.length > 0) {
            await context.onJobsFetched(mapJobsToSummaries(jobs));
          }

          return result;
        } catch (err) {
          logger.error('获取岗位列表失败', err);
          return {
            error: `获取岗位列表失败: ${err instanceof Error ? err.message : '未知错误'}`,
          };
        }
      },
    });
  };
}
