/**
 * DuLiDay 岗位查询工具（LLM 优化版）
 *
 * 渐进式数据返回：通过 6 个布尔开关控制返回的数据字段。
 * 支持 markdown / rawData 两种输出格式。
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

// ==================== 工具函数 ====================

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

function joinParts(parts: (string | null | undefined)[], separator = ' '): string {
  return parts.filter((p) => hasValue(p)).join(separator);
}

function normalizeKeyword(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

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

function addLine(lines: string[], label: string, value: string | null | undefined): void {
  if (hasValue(value) && typeof value === 'string') {
    const cleaned = cleanPolicyText(value);
    if (cleaned) lines.push(`- **${label}**: ${cleaned}`);
  } else if (hasValue(value)) {
    lines.push(`- **${label}**: ${value}`);
  }
}

const FIELD_LABEL_MAP: Record<string, string> = {
  basicInfo: '基本信息',
  jobSalary: '薪资信息',
  welfare: '福利信息',
  hiringRequirement: '招聘要求',
  workTime: '工作时间',
  interviewProcess: '面试流程',
  jobId: '岗位ID',
  jobName: '岗位名称',
  jobNickName: '岗位简称',
  jobCategoryName: '岗位类型',
  jobContent: '工作内容',
  laborForm: '用工形式',
  storeInfo: '门店信息',
  storeId: '门店ID',
  storeName: '门店名称',
  storeCityName: '城市',
  storeRegionName: '区域',
  storeAddress: '门店地址',
  longitude: '经度',
  latitude: '纬度',
  brandName: '品牌',
  brandId: '品牌ID',
  projectId: '项目ID',
  projectName: '项目名称',
  createTime: '创建时间',
  needProbationWork: '是否需要试工',
  needTraining: '是否需要培训',
  haveProbation: '是否有试用',
  employmentForm: '就业形式',
  employmentDescription: '就业形式说明',
  minWorkMonths: '最少工作月数',
  temporaryEmployment: '短期用工',
  temporaryEmploymentStartTime: '短期用工开始时间',
  temporaryEmploymentEndTime: '短期用工结束时间',
  weekWorkTime: '每周工时',
  weekWorkTimeRequirement: '每周工时要求',
  perWeekWorkDays: '每周工作天数',
  perWeekRestDays: '每周休息天数',
  perWeekNeedWorkDays: '每周需出勤天数',
  workSingleDouble: '单双休',
  customnWorkTimeList: '自定义每周工时配置',
  customMinWorkDays: '最少出勤天数',
  customMaxWorkDays: '最多出勤天数',
  customWorkWeekdays: '可出勤星期',
  monthWorkTime: '每月工时',
  perMonthMinWorkTime: '每月最少工时',
  perMonthMinWorkTimeUnit: '每月最少工时单位',
  monthWorkTimeRequirement: '每月工时要求',
  perMonthMaxRestTime: '每月最多休息时长',
  perMonthMaxRestTimeUnit: '每月最多休息时长单位',
  dayWorkTime: '每日工时',
  perDayMinWorkHours: '每日最少工时',
  dayWorkTimeRequirement: '每日工时要求',
  dailyShiftSchedule: '排班信息',
  arrangementType: '排班类型',
  fixedScheduleList: '固定班次',
  fixedShiftStartTime: '班次开始时间',
  fixedShiftEndTime: '班次结束时间',
  combinedArrangement: '组合排班',
  fixedTime: '固定时间段',
  goToWorkStartTime: '上班开始时间',
  goToWorkEndTime: '上班结束时间',
  goOffWorkStartTime: '下班开始时间',
  goOffWorkEndTime: '下班结束时间',
  restTimeDesc: '休息说明',
  workTimeRemark: '工时备注',
  salaryScenarioList: '薪资方案',
  salaryType: '薪资类型',
  salaryPeriod: '结算周期',
  payday: '发薪日',
  hasStairSalary: '是否阶梯薪资',
  basicSalary: '基础薪资',
  basicSalaryUnit: '基础薪资单位',
  stairSalaries: '阶梯薪资配置',
  description: '说明',
  perTimeUnit: '统计周期',
  fullWorkTime: '阈值工时',
  fullWorkTimeUnit: '阈值工时单位',
  salary: '薪资',
  salaryUnit: '薪资单位',
  comprehensiveSalary: '综合薪资',
  minComprehensiveSalary: '综合薪资下限',
  maxComprehensiveSalary: '综合薪资上限',
  comprehensiveSalaryUnit: '综合薪资单位',
  holidaySalary: '节假日薪资',
  holidaySalaryType: '节假日薪资类型',
  holidaySalaryMultiple: '节假日薪资倍数',
  holidayFixedSalary: '节假日固定薪资',
  holidayFixedSalaryUnit: '节假日固定薪资单位',
  holidaySalaryDesc: '节假日薪资说明',
  overtimeSalary: '加班薪资',
  overtimeSalaryType: '加班薪资类型',
  overtimeSalaryMultiple: '加班薪资倍数',
  overtimeFixedSalary: '加班固定薪资',
  overtimeFixedSalaryUnit: '加班固定薪资单位',
  overtimeSalaryDesc: '加班薪资说明',
  otherSalary: '其他薪资',
  commission: '提成',
  attendanceSalary: '全勤奖',
  attendanceSalaryUnit: '全勤奖单位',
  performance: '绩效',
  customSalaries: '自定义薪资',
  probationSalary: '试工薪资',
  salaryDescription: '薪资说明',
  haveInsurance: '保险',
  accommodation: '住宿',
  accommodationAllowance: '住宿补贴',
  accommodationAllowanceUnit: '住宿补贴单位',
  probationAccommodationAllowanceReceive: '试工期住宿补贴领取',
  catering: '餐饮',
  cateringSalary: '餐补',
  cateringSalaryUnit: '餐补单位',
  trafficAllowanceSalary: '交通补贴',
  trafficAllowanceSalaryUnit: '交通补贴单位',
  promotionWelfare: '晋升福利',
  otherWelfare: '其他福利',
  memo: '备注',
  interviewTotal: '面试轮数',
  firstInterview: '一轮面试',
  firstInterviewWay: '一面方式',
  interviewAddress: '面试地址',
  interviewDemand: '面试要求',
  firstInterviewDesc: '一面说明',
  interviewTimeMode: '面试时间模式',
  fixedInterviewTimes: '固定面试时间',
  interviewDate: '面试日期',
  interviewTimes: '面试时间段',
  interviewStartTime: '面试开始时间',
  interviewEndTime: '面试结束时间',
  fixedDeadline: '固定报名截止时间',
  periodicInterviewTimes: '周期面试时间',
  interviewWeekday: '面试星期',
  cycleDeadlineDay: '周期报名截止日',
  cycleDeadlineEnd: '周期报名截止时间',
  secondInterview: '二轮面试',
  secondInterviewDemand: '二面要求',
  secondInterviewWay: '二面方式',
  secondInterviewAddress: '二面地址',
  thirdInterview: '三轮面试',
  thirdInterviewDemand: '三面要求',
  thirdInterviewWay: '三面方式',
  thirdInterviewAddress: '三面地址',
  interviewSupplement: '面试补充项',
  interviewSupplementId: '面试补充项ID',
  probationWork: '试工信息',
  probationWorkPeriod: '试工周期',
  probationWorkPeriodUnit: '试工周期单位',
  probationWorkAddress: '试工地址',
  probationWorkAssessment: '试工考核方式',
  probationWorkAssessmentText: '试工考核说明',
  training: '培训信息',
  trainingAddress: '培训地址',
  trainingPeriod: '培训周期',
  trainingPeriodUnit: '培训周期单位',
  trainingDesc: '培训说明',
  processDesc: '流程说明',
  remark: '备注',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatProjectionLabel(segment: string): string {
  return FIELD_LABEL_MAP[segment] ?? segment;
}

function formatProjectionPath(path: Array<string | number>): string {
  let rendered = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `（第${segment + 1}项）`;
      continue;
    }
    const label = formatProjectionLabel(segment);
    rendered = rendered ? `${rendered} / ${label}` : label;
  }
  return rendered;
}

function normalizeProjectionScalar(value: unknown): string {
  if (value === null || value === undefined) return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    const cleaned = cleanPolicyText(value);
    const sanitized = sanitizeConstraintText(cleaned);
    return sanitized ?? '未设置';
  }
  return String(value);
}

function collectProjectionLines(
  value: unknown,
  path: Array<string | number>,
  lines: string[],
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`- **${formatProjectionPath(path)}**: 空`);
      return;
    }

    const allScalar = value.every((item) => !Array.isArray(item) && !isPlainObject(item));
    if (allScalar) {
      const joined = value.map((item) => normalizeProjectionScalar(item)).join('、');
      lines.push(`- **${formatProjectionPath(path)}**: ${joined}`);
      return;
    }

    value.forEach((item, index) => {
      collectProjectionLines(item, [...path, index], lines);
    });
    return;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`- **${formatProjectionPath(path)}**: 空`);
      return;
    }

    entries.forEach(([key, nested]) => {
      collectProjectionLines(nested, [...path, key], lines);
    });
    return;
  }

  lines.push(`- **${formatProjectionPath(path)}**: ${normalizeProjectionScalar(value)}`);
}

function formatProjectedFieldBlock(title: string, payload: unknown): string {
  if (!isPlainObject(payload)) return '';
  const lines: string[] = [];
  Object.entries(payload).forEach(([key, value]) => {
    collectProjectionLines(value, [key], lines);
  });
  if (lines.length === 0) return '';
  return `#### ${title}\n${lines.join('\n')}\n\n`;
}

function formatInterviewDecisionSummary(policy: JobPolicyAnalysis): string {
  const lines: string[] = [];

  if (policy.normalizedRequirements.ageRequirement !== '不限') {
    addLine(lines, '年龄要求', policy.normalizedRequirements.ageRequirement);
  }

  if (policy.normalizedRequirements.healthCertificateRequirement !== '未明确要求') {
    addLine(lines, '健康证', policy.normalizedRequirements.healthCertificateRequirement);
  }

  if (policy.highlights.requirementHighlights.length > 0) {
    addLine(lines, '关键要求', policy.highlights.requirementHighlights.join('；'));
  }

  if (policy.interviewMeta.method) {
    addLine(lines, '面试形式', policy.interviewMeta.method);
  }

  if (policy.interviewMeta.demand) {
    addLine(lines, '报名要求', policy.interviewMeta.demand);
  }

  if (policy.interviewMeta.timeHint) {
    addLine(lines, '面试时间', policy.interviewMeta.timeHint);
  }

  if (policy.interviewMeta.registrationDeadlineHint) {
    addLine(lines, '报名截止', policy.interviewMeta.registrationDeadlineHint);
  }

  if (policy.highlights.timingHighlights.length > 0) {
    addLine(lines, '时效限制', policy.highlights.timingHighlights.join('；'));
  }

  return lines.length > 0 ? '### 约面重点\n' + lines.join('\n') + '\n\n' : '';
}

// ==================== 格式化函数 ====================

/* eslint-disable @typescript-eslint/no-explicit-any */

function formatSalaryInfo(job: any): string {
  const salary = job.jobSalary;
  if (!salary) return '';
  const lines: string[] = [];

  salary.salaryScenarioList?.forEach((scenario: any) => {
    const stagePrefix = scenario.salaryType ? `${scenario.salaryType}期` : '';

    const basic = scenario.basicSalary;
    if (basic && hasValue(basic.basicSalary)) {
      addLine(
        lines,
        `${stagePrefix}基本薪资`,
        `${basic.basicSalary}${basic.basicSalaryUnit || '元'}`,
      );
    }

    const comp = scenario.comprehensiveSalary;
    if (comp && (hasValue(comp.minComprehensiveSalary) || hasValue(comp.maxComprehensiveSalary))) {
      const min = comp.minComprehensiveSalary ?? '?';
      const max = comp.maxComprehensiveSalary ?? '?';
      addLine(
        lines,
        `${stagePrefix}综合薪资`,
        `${min}-${max} ${comp.comprehensiveSalaryUnit || '元/月'}`,
      );
    }

    const periodParts = [scenario.salaryPeriod, scenario.payday ? `${scenario.payday}发薪` : null];
    const periodStr = joinParts(periodParts, '，');
    if (periodStr) addLine(lines, `${stagePrefix}结算周期`, periodStr);

    if (scenario.stairSalaries?.length) {
      const stairInfo = scenario.stairSalaries
        .filter((s: any) => hasValue(s.salary))
        .map((s: any) => {
          const threshold = hasValue(s.fullWorkTime)
            ? `超过${s.fullWorkTime}${s.fullWorkTimeUnit || ''} `
            : '';
          const desc = s.description ? `(${s.description})` : '';
          return `${threshold}${desc}按 ${s.salary}${s.salaryUnit || '元'} 结算`;
        })
        .join('；');
      if (stairInfo) addLine(lines, `${stagePrefix}阶梯薪资`, stairInfo);
    }

    const holiday = scenario.holidaySalary;
    if (holiday && holiday.holidaySalaryType !== '无薪资') {
      let holidayStr = '';
      if (hasValue(holiday.holidayFixedSalary)) {
        holidayStr = `${holiday.holidayFixedSalary}${holiday.holidayFixedSalaryUnit || '元'}`;
      } else if (hasValue(holiday.holidaySalaryMultiple)) {
        holidayStr = `${holiday.holidaySalaryMultiple}倍`;
      }
      if (hasValue(holiday.holidaySalaryDesc)) {
        holidayStr = joinParts([holidayStr, `(${holiday.holidaySalaryDesc})`]);
      }
      if (holidayStr) addLine(lines, `${stagePrefix}节假日薪资`, holidayStr);
    }

    const overtime = scenario.overtimeSalary;
    if (overtime && overtime.overtimeSalaryType !== '无薪资') {
      let overtimeStr = '';
      if (hasValue(overtime.overtimeFixedSalary)) {
        overtimeStr = `${overtime.overtimeFixedSalary}${overtime.overtimeFixedSalaryUnit || '元'}`;
      } else if (hasValue(overtime.overtimeSalaryMultiple)) {
        overtimeStr = `${overtime.overtimeSalaryMultiple}倍`;
      }
      if (hasValue(overtime.overtimeSalaryDesc)) {
        overtimeStr = joinParts([overtimeStr, `(${overtime.overtimeSalaryDesc})`]);
      }
      if (overtimeStr) addLine(lines, `${stagePrefix}加班薪资`, overtimeStr);
    }

    const other = scenario.otherSalary;
    if (other) {
      if (hasValue(other.commission)) addLine(lines, `${stagePrefix}提成`, other.commission);
      if (hasValue(other.attendanceSalary)) {
        addLine(
          lines,
          `${stagePrefix}全勤奖`,
          `${other.attendanceSalary}${other.attendanceSalaryUnit || '元'}`,
        );
      }
      if (hasValue(other.performance)) addLine(lines, `${stagePrefix}绩效`, other.performance);
    }

    scenario.customSalaries?.forEach((custom: any) => {
      if (hasValue(custom.name) && hasValue(custom.salary)) {
        addLine(lines, `${stagePrefix}${custom.name}`, custom.salary);
      }
    });
  });

  const probation = salary.probationSalary;
  if (probation) {
    if (hasValue(probation.salary)) {
      let probStr = `${probation.salary}${probation.salaryUnit || '元'}`;
      if (hasValue(probation.salaryDescription)) probStr += `（${probation.salaryDescription}）`;
      addLine(lines, '试工期薪资', probStr);
    } else if (hasValue(probation.salaryDescription)) {
      addLine(lines, '试工期说明', probation.salaryDescription);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function formatWelfareInfo(job: any): string {
  const welfare = job.welfare;
  if (!welfare) return '';
  const lines: string[] = [];

  if (hasValue(welfare.catering) && welfare.catering !== '无餐饮福利') {
    let s = welfare.catering;
    if (hasValue(welfare.cateringSalary))
      s += `（餐补${welfare.cateringSalary}${welfare.cateringSalaryUnit || '元'}）`;
    addLine(lines, '餐饮', s);
  }
  if (hasValue(welfare.accommodation) && welfare.accommodation !== '无住宿福利') {
    let s = welfare.accommodation;
    if (hasValue(welfare.accommodationAllowance)) {
      s += `（补贴${welfare.accommodationAllowance}${welfare.accommodationAllowanceUnit || '元'}）`;
    }
    addLine(lines, '住宿', s);
  }
  if (hasValue(welfare.trafficAllowanceSalary)) {
    addLine(
      lines,
      '交通补贴',
      `${welfare.trafficAllowanceSalary}${welfare.trafficAllowanceSalaryUnit || '元'}`,
    );
  }
  if (hasValue(welfare.haveInsurance)) addLine(lines, '保险', welfare.haveInsurance);
  if (hasValue(welfare.promotionWelfare)) addLine(lines, '晋升', welfare.promotionWelfare);
  const otherItems = welfare.otherWelfare?.filter((w: any) => hasValue(w));
  if (otherItems?.length) addLine(lines, '其他福利', otherItems.join('、'));
  if (hasValue(welfare.memo)) addLine(lines, '福利说明', welfare.memo);

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function formatRequirements(job: any, policy: JobPolicyAnalysis): string {
  const req = job.hiringRequirement;
  if (!req && !policy) return '';
  const lines: string[] = [];

  if (
    hasValue(policy.normalizedRequirements.genderRequirement) &&
    policy.normalizedRequirements.genderRequirement !== '不限'
  ) {
    addLine(lines, '性别', policy.normalizedRequirements.genderRequirement);
  }
  if (policy.normalizedRequirements.ageRequirement !== '不限') {
    addLine(lines, '年龄', policy.normalizedRequirements.ageRequirement);
  }
  if (
    hasValue(policy.normalizedRequirements.educationRequirement) &&
    policy.normalizedRequirements.educationRequirement !== '不限'
  ) {
    addLine(lines, '学历', `${policy.normalizedRequirements.educationRequirement}及以上`);
  }
  if (policy.normalizedRequirements.healthCertificateRequirement !== '未明确要求') {
    addLine(lines, '健康证', policy.normalizedRequirements.healthCertificateRequirement);
  }
  if (policy.normalizedRequirements.remark)
    addLine(lines, '其他要求', policy.normalizedRequirements.remark);

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function formatWorkTime(job: any): string {
  const wt = job.workTime;
  if (!wt) return '';
  const lines: string[] = [];

  if (hasValue(wt.employmentForm)) {
    let s = wt.employmentForm;
    if (hasValue(wt.employmentDescription)) s += `（${wt.employmentDescription}）`;
    addLine(lines, '就业形式', s);
  }
  if (hasValue(wt.minWorkMonths)) addLine(lines, '最少工作', `${wt.minWorkMonths}个月`);

  const week = wt.weekWorkTime;
  if (week) {
    const parts: string[] = [];
    if (hasValue(week.perWeekWorkDays)) parts.push(`每周${week.perWeekWorkDays}天`);
    if (hasValue(week.perWeekRestDays)) parts.push(`休${week.perWeekRestDays}天`);
    if (parts.length > 0) addLine(lines, '每周工时', parts.join('，'));
  }

  const day = wt.dayWorkTime;
  if (day && hasValue(day.perDayMinWorkHours)) {
    addLine(lines, '每日工时', `${day.perDayMinWorkHours}小时`);
  }

  const schedule = wt.dailyShiftSchedule;
  if (schedule && hasValue(schedule.arrangementType)) {
    addLine(lines, '排班类型', schedule.arrangementType);
  }

  if (hasValue(wt.workTimeRemark)) {
    addLine(lines, '工时备注', sanitizeConstraintText(wt.workTimeRemark));
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function formatInterviewInfo(job: any, policy: JobPolicyAnalysis): string {
  const ip = job.interviewProcess;
  if (!ip && !policy) return '';
  const lines: string[] = [];

  if (hasValue(ip?.interviewTotal)) addLine(lines, '面试轮数', `${ip.interviewTotal}轮`);

  if (policy.interviewMeta.method) addLine(lines, '一面方式', policy.interviewMeta.method);
  if (policy.interviewMeta.address) addLine(lines, '一面地址', policy.interviewMeta.address);
  if (policy.interviewMeta.demand) addLine(lines, '面试要求', policy.interviewMeta.demand);

  const probation = ip?.probationWork;
  if (probation) {
    const parts: string[] = [];
    if (hasValue(probation.probationWorkPeriod)) {
      parts.push(`${probation.probationWorkPeriod}${probation.probationWorkPeriodUnit || '天'}`);
    }
    if (probation.probationWorkAssessment) parts.push(probation.probationWorkAssessment);
    if (parts.length > 0) addLine(lines, '试工', parts.join('，'));
  }

  const training = ip?.training;
  if (training) {
    const parts: string[] = [];
    if (hasValue(training.trainingPeriod)) {
      parts.push(`${training.trainingPeriod}${training.trainingPeriodUnit || '天'}`);
    }
    if (training.trainingDesc) parts.push(training.trainingDesc);
    if (parts.length > 0) addLine(lines, '培训', parts.join('，'));
  }

  if (policy.normalizedRequirements.interviewRemark) {
    addLine(lines, '面试备注', policy.normalizedRequirements.interviewRemark);
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ==================== 岗位格式化 ====================

/* eslint-disable @typescript-eslint/no-explicit-any */

function formatJobToOneLine(job: any, index: number): string {
  const bi = job.basicInfo;
  const store = bi.storeInfo;
  const parts = [`${index + 1}. **${bi.brandName || ''} - ${bi.jobName || '未命名'}**`];
  if (store?.storeName) parts.push(store.storeName);
  if (store?.storeAddress) parts.push(store.storeAddress);
  if (job._distanceKm != null) parts.push(`距离 ${job._distanceKm.toFixed(1)}km`);
  return parts.join(' | ');
}

function formatBasicInfoSection(job: any): string {
  const bi = job.basicInfo;
  const store = bi.storeInfo;
  const lines: string[] = [];
  if (hasValue(bi.brandName)) addLine(lines, '品牌', bi.brandName);
  if (store?.storeName) addLine(lines, '门店', store.storeName);
  if (store?.storeAddress) addLine(lines, '地址', store.storeAddress);
  if (job._distanceKm != null) addLine(lines, '距离', `${job._distanceKm.toFixed(1)}km`);
  if (hasValue(bi.jobCategoryName)) addLine(lines, '岗位类型', bi.jobCategoryName);
  if (hasValue(bi.laborForm)) addLine(lines, '用工形式', bi.laborForm);
  if (bi.jobContent) addLine(lines, '工作内容', bi.jobContent);
  return lines.length > 0 ? '### 基本信息\n' + lines.join('\n') + '\n\n' : '';
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
  if (hasValue(bi.jobNickName) && bi.jobNickName !== bi.jobName)
    titleParts.push(`(${bi.jobNickName})`);
  let md = `## ${index + 1}. ${titleParts.join(' ')}\n\n`;

  if (flags.includeHiringRequirement || flags.includeInterviewProcess) {
    md += formatInterviewDecisionSummary(policy);
  }
  if (flags.includeBasicInfo) {
    md += formatBasicInfoSection(job);
    md += formatProjectedFieldBlock('基本信息字段投影', job.basicInfo);
  }
  if (flags.includeJobSalary) {
    const s = formatSalaryInfo(job);
    if (s) md += '### 薪资信息\n' + s + '\n';
    md += formatProjectedFieldBlock('薪资字段投影', job.jobSalary);
  }
  if (flags.includeWelfare) {
    const s = formatWelfareInfo(job);
    if (s) md += '### 福利信息\n' + s + '\n';
    md += formatProjectedFieldBlock('福利字段投影', job.welfare);
  }
  if (flags.includeHiringRequirement) {
    const s = formatRequirements(job, policy);
    if (s) md += '### 招聘要求\n' + s + '\n';
    md += formatProjectedFieldBlock('招聘要求字段投影', job.hiringRequirement);
  }
  if (flags.includeWorkTime) {
    const s = formatWorkTime(job);
    if (s) md += '### 工作时间\n' + s + '\n';
    md += formatProjectedFieldBlock('工作时间字段投影', job.workTime);
  }
  if (flags.includeInterviewProcess) {
    const s = formatInterviewInfo(job, policy);
    if (s) md += '### 面试流程\n' + s + '\n';
    md += formatProjectedFieldBlock('面试流程字段投影', job.interviewProcess);
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

// ==================== 薪资摘要 ====================

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

function mapJobsToSummaries(jobs: any[]): RecommendedJobSummary[] {
  return jobs.map((job) => ({
    jobId: job.basicInfo.jobId,
    brandName: job.basicInfo.brandName ?? null,
    jobName: job.basicInfo.jobName ?? null,
    storeName: job.basicInfo.storeInfo?.storeName ?? null,
    cityName: job.basicInfo.storeInfo?.storeCityName ?? null,
    regionName: job.basicInfo.storeInfo?.storeRegionName ?? null,
    laborForm: job.basicInfo.laborForm ?? null,
    salaryDesc: formatSalarySummary(job),
    jobCategoryName: job.basicInfo.jobCategoryName ?? null,
    distanceKm: job._distanceKm != null ? Math.round(job._distanceKm * 10) / 10 : null,
  }));
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
        try {
          let storeMatchStrategy: 'api_exact' | 'local_fuzzy_match' = 'api_exact';
          let jobCategoryMatchStrategy: 'api_exact' | 'local_keyword_match' = 'api_exact';

          // 首次请求
          let { jobs, total } = await spongeService.fetchJobs({
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
          });

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

            const filtered = filterJobsByRequestedCategories(
              fallback.jobs as any[],
              jobCategoryList,
            );
            if (filtered.length > 0) {
              jobCategoryMatchStrategy = 'local_keyword_match';
              jobs = filtered;
              total = filtered.length;
            }
          }

          // 距离计算 + 阈值过滤
          const hasUserCoords = userLatitude != null && userLongitude != null;
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

            // 从业务阈值读取距离上限
            const distanceThreshold = context.thresholds?.find(
              (t) => t.flag === 'max_recommend_distance_km',
            );
            const maxKm = distanceThreshold?.max;

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
