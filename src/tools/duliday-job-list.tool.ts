/**
 * DuLiDay 岗位查询工具（LLM 优化版）
 *
 * 渐进式数据返回：通过 6 个布尔开关控制返回的数据字段。
 * 支持 markdown / rawData 两种输出格式。
 *
 * 迁移自 agent/tools/duliday-job-list.tool.ts
 * 改造：实现 ToolFactory 接口 + 使用 SpongeService
 */

import { Injectable, Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { AiTool, ToolBuildContext, ToolFactory } from './tool.types';

// ==================== 常量 ====================

const DEFAULT_PAGE_NUM = 1;
const DEFAULT_PAGE_SIZE = 20;

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

function cleanText(text: string): string {
  if (!text) return '';
  return text
    .replace(/辛苦跟.*?[。！？]/g, '')
    .replace(/务必.*?[。！？]/g, '')
    .replace(/手动输入/g, '')
    .replace(/！{2,}/g, '！')
    .replace(/[\n\r]+/g, '；')
    .replace(/；{2,}/g, '；')
    .replace(/^；+|；+$/g, '');
}

function addLine(lines: string[], label: string, value: string | null | undefined): void {
  if (hasValue(value) && typeof value === 'string') {
    const cleaned = cleanText(value);
    if (cleaned) lines.push(`- **${label}**: ${cleaned}`);
  } else if (hasValue(value)) {
    lines.push(`- **${label}**: ${value}`);
  }
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

function formatRequirements(job: any): string {
  const req = job.hiringRequirement;
  if (!req) return '';
  const lines: string[] = [];

  const basic = req.basicPersonalRequirements;
  if (basic) {
    if (hasValue(basic.genderRequirement) && basic.genderRequirement !== '不限') {
      addLine(lines, '性别', basic.genderRequirement);
    }
    if (hasValue(basic.minAge) || hasValue(basic.maxAge)) {
      addLine(lines, '年龄', `${basic.minAge ?? '不限'}-${basic.maxAge ?? '不限'}岁`);
    }
  }

  const cert = req.certificate;
  if (cert) {
    if (hasValue(cert.education) && cert.education !== '不限')
      addLine(lines, '学历', `${cert.education}及以上`);
    if (hasValue(cert.healthCertificate)) addLine(lines, '健康证', cert.healthCertificate);
  }

  if (req.remark) addLine(lines, '其他要求', req.remark);

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

  if (hasValue(wt.workTimeRemark)) addLine(lines, '工时备注', wt.workTimeRemark);

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function formatInterviewInfo(job: any): string {
  const ip = job.interviewProcess;
  if (!ip) return '';
  const lines: string[] = [];

  if (hasValue(ip.interviewTotal)) addLine(lines, '面试轮数', `${ip.interviewTotal}轮`);

  const first = ip.firstInterview;
  if (first) {
    if (hasValue(first.firstInterviewWay)) addLine(lines, '一面方式', first.firstInterviewWay);
    if (hasValue(first.interviewAddress)) addLine(lines, '一面地址', first.interviewAddress);
    if (hasValue(first.interviewDemand)) addLine(lines, '面试要求', first.interviewDemand);
  }

  const probation = ip.probationWork;
  if (probation) {
    const parts: string[] = [];
    if (hasValue(probation.probationWorkPeriod)) {
      parts.push(`${probation.probationWorkPeriod}${probation.probationWorkPeriodUnit || '天'}`);
    }
    if (probation.probationWorkAssessment) parts.push(probation.probationWorkAssessment);
    if (parts.length > 0) addLine(lines, '试工', parts.join('，'));
  }

  const training = ip.training;
  if (training) {
    const parts: string[] = [];
    if (hasValue(training.trainingPeriod)) {
      parts.push(`${training.trainingPeriod}${training.trainingPeriodUnit || '天'}`);
    }
    if (training.trainingDesc) parts.push(training.trainingDesc);
    if (parts.length > 0) addLine(lines, '培训', parts.join('，'));
  }

  if (ip.remark) addLine(lines, '面试备注', ip.remark);

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
  return parts.join(' | ');
}

function formatBasicInfoSection(job: any): string {
  const bi = job.basicInfo;
  const store = bi.storeInfo;
  const lines: string[] = [];
  if (hasValue(bi.brandName)) addLine(lines, '品牌', bi.brandName);
  if (store?.storeName) addLine(lines, '门店', store.storeName);
  if (store?.storeAddress) addLine(lines, '地址', store.storeAddress);
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
  const titleParts = [bi.jobName || '未命名岗位'];
  if (hasValue(bi.jobNickName) && bi.jobNickName !== bi.jobName)
    titleParts.push(`(${bi.jobNickName})`);
  let md = `## ${index + 1}. ${titleParts.join(' ')}\n\n`;

  if (flags.includeBasicInfo) md += formatBasicInfoSection(job);
  if (flags.includeJobSalary) {
    const s = formatSalaryInfo(job);
    if (s) md += '### 薪资信息\n' + s + '\n';
  }
  if (flags.includeWelfare) {
    const s = formatWelfareInfo(job);
    if (s) md += '### 福利信息\n' + s + '\n';
  }
  if (flags.includeHiringRequirement) {
    const s = formatRequirements(job);
    if (s) md += '### 招聘要求\n' + s + '\n';
  }
  if (flags.includeWorkTime) {
    const s = formatWorkTime(job);
    if (s) md += '### 工作时间\n' + s + '\n';
  }
  if (flags.includeInterviewProcess) {
    const s = formatInterviewInfo(job);
    if (s) md += '### 面试流程\n' + s + '\n';
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

interface RecommendedJobSummary {
  jobId: number;
  brandName: string | null;
  jobName: string | null;
  storeName: string | null;
  cityName: string | null;
  regionName: string | null;
  laborForm: string | null;
  salaryDesc: string | null;
  jobCategoryName: string | null;
}

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
  }));
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ==================== 服务 ====================

@Injectable()
export class DulidayJobListToolService implements ToolFactory {
  readonly toolName = 'duliday_job_list';
  readonly toolDescription = `查询在招岗位列表。支持渐进式数据返回，按需获取岗位信息。
筛选条件：城市、区域、品牌、门店、岗位类型、岗位ID
数据开关：
- includeBasicInfo（默认true）：品牌、门店、地址等基本信息
- includeJobSalary：薪资信息
- includeWelfare：福利信息
- includeHiringRequirement：招聘要求
- includeWorkTime：工作时间/班次
- includeInterviewProcess：面试流程`;

  private readonly logger = new Logger(DulidayJobListToolService.name);

  constructor(private readonly spongeService: SpongeService) {}

  buildTool(context: ToolBuildContext): AiTool {
    return tool({
      description: this.toolDescription,
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
          // 首次请求
          let { jobs, total } = await this.spongeService.fetchJobs({
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
            const fallback = await this.spongeService.fetchJobs({ options });
            if (fallback.jobs.length > 0) {
              /* eslint-disable @typescript-eslint/no-explicit-any */
              const lowerKeywords = storeNameList.map((s) => s.toLowerCase());
              const filtered = fallback.jobs.filter((job: any) => {
                const storeName = (job.basicInfo?.storeInfo?.storeName || '').toLowerCase();
                return lowerKeywords.some((kw) => storeName.includes(kw));
              });
              /* eslint-enable @typescript-eslint/no-explicit-any */
              if (filtered.length > 0) {
                jobs = filtered;
                total = filtered.length;
              }
            }
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

          // 通知调用方已获取岗位数据
          if (context.onJobsFetched && jobs.length > 0) {
            context.onJobsFetched(mapJobsToSummaries(jobs));
          }

          return result;
        } catch (err) {
          this.logger.error('获取岗位列表失败', err);
          return {
            error: `获取岗位列表失败: ${err instanceof Error ? err.message : '未知错误'}`,
          };
        }
      },
    });
  }
}
