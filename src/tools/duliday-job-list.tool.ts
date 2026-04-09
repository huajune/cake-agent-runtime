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
  jobCategoryList: z.array(z.string()).optional().default([]).describe('岗位类型列表'),
  brandIdList: z.array(z.number().int()).optional().default([]).describe('品牌ID列表'),
  projectNameList: z.array(z.string()).optional().default([]).describe('项目名称列表'),
  projectIdList: z.array(z.number().int()).optional().default([]).describe('项目ID列表'),
  jobIdList: z.array(z.number().int()).optional().default([]).describe('岗位ID列表'),

  userLatitude: z.number().optional().describe('用户纬度（通过 geocode 工具或位置分享获取）'),
  userLongitude: z.number().optional().describe('用户经度（通过 geocode 工具或位置分享获取）'),

  responseFormat: z
    .array(z.enum(['markdown', 'rawData']))
    .optional()
    .default(['markdown'])
    .describe('返回格式，可多选。默认 ["markdown"]'),

  includeBasicInfo: z.boolean().optional().default(true).describe('返回基本信息 - 默认true'),
  includeJobSalary: z.boolean().optional().default(false).describe('返回薪资信息'),
  includeWelfare: z.boolean().optional().default(false).describe('返回福利信息'),
  includeHiringRequirement: z.boolean().optional().default(false).describe('返回招聘要求'),
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

  pushField(lines, '岗位名称', bi.jobName);
  pushField(lines, '岗位简称', bi.jobNickName);
  pushField(lines, '岗位类型', bi.jobCategoryName);
  pushField(lines, '用工形式', bi.laborForm);
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
筛选条件：城市、区域、品牌、门店、岗位类型、岗位ID
距离过滤：传入 userLatitude + userLongitude 后，自动计算门店距离并按业务阈值过滤，结果按距离排序
规则摘要：会结合岗位结构化字段与备注提炼推荐阶段要点，但不负责真正提交预约
数据开关：
- includeBasicInfo（默认true）：品牌、门店、地址等基本信息
- includeJobSalary：薪资信息
- includeWelfare：福利信息
- includeHiringRequirement：招聘要求
- includeWorkTime：工作时间/班次
- includeInterviewProcess：面试流程`;

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
        userLatitude,
        userLongitude,
        responseFormat = ['markdown'],
        includeBasicInfo = true,
        includeJobSalary = false,
        includeWelfare = false,
        includeHiringRequirement = false,
        includeWorkTime = false,
        includeInterviewProcess = false,
      }) => {
        const options = {
          includeBasicInfo,
          includeJobSalary,
          includeWelfare,
          includeHiringRequirement,
          includeWorkTime,
          includeInterviewProcess,
        };
        const fetchBaseParams = {
          cityNameList,
          regionNameList,
          brandAliasList,
          brandIdList,
          projectNameList,
          projectIdList,
          storeNameList,
          jobCategoryList,
          jobIdList,
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
          if (jobs.length === 0 && jobCategoryList.length > 0) {
            const fallback = await spongeService.fetchJobs({
              cityNameList,
              regionNameList,
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
              jobCategoryList,
            );
            /* eslint-enable @typescript-eslint/no-explicit-any */
            if (filtered.length > 0) {
              jobCategoryMatchStrategy = 'local_keyword_match';
              jobs = filtered;
              total = filtered.length;
            }
          }

          // 距离计算 + 阈值过滤
          const hasUserCoords = userLatitude != null && userLongitude != null;
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
                  userLatitude!,
                  userLongitude!,
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
