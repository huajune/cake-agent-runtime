import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { formatLocalDate, getTomorrowDate } from '@infra/utils/date.util';
import {
  buildJobPolicyAnalysis,
  InterviewWindow,
  normalizePolicyText,
} from '@tools/duliday/job-policy-parser';

const logger = new Logger('duliday_interview_precheck');

const inputSchema = z.object({
  jobId: z.number().describe('岗位 ID'),
  requestedDate: z
    .string()
    .optional()
    .describe('候选人想约的日期。支持 today、tomorrow、今天、明天、YYYY-MM-DD'),
});

function normalizeRequestedDate(input?: string): { date: string | null; error?: string } {
  const raw = normalizePolicyText(input);
  if (!raw) return { date: null };

  if (raw === 'today' || raw === '今天') {
    return { date: formatLocalDate(new Date()) };
  }
  if (raw === 'tomorrow' || raw === '明天') {
    return { date: getTomorrowDate() };
  }

  const normalized = raw.replace(/\//g, '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return { date: normalized };
  }

  return { date: null, error: `无法识别的日期：${raw}` };
}

function formatShanghaiTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function getShanghaiWeekday(dateStr: string): string {
  const label = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(new Date(`${dateStr}T12:00:00+08:00`));

  const map: Record<string, string> = {
    星期一: '每周一',
    星期二: '每周二',
    星期三: '每周三',
    星期四: '每周四',
    星期五: '每周五',
    星期六: '每周六',
    星期日: '每周日',
    周一: '每周一',
    周二: '每周二',
    周三: '每周三',
    周四: '每周四',
    周五: '每周五',
    周六: '每周六',
    周日: '每周日',
  };

  return map[label] ?? label;
}

function compareTime(a: string, b: string): number {
  return a.localeCompare(b);
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function evaluateRequestedDate(params: {
  date: string;
  windows: InterviewWindow[];
  basePolicyNotes?: string[];
}): {
  status: 'available' | 'unavailable' | 'needs_confirmation';
  canSchedule: boolean | null;
  matchedWindows: InterviewWindow[];
  reason: string;
  policyNotes: string[];
  decisionBasis:
    | 'no_matching_schedule'
    | 'future_schedule_match'
    | 'same_day_after_latest_window'
    | 'same_day_window_requires_confirmation';
} {
  const { date, windows, basePolicyNotes = [] } = params;
  const weekday = getShanghaiWeekday(date);
  const today = formatLocalDate(new Date());
  const nowTime = formatShanghaiTime(new Date());
  const matchedWindows = windows.filter((window) => {
    if (window.date) return window.date === date;
    if (window.weekday) return window.weekday === weekday;
    return false;
  });

  if (matchedWindows.length === 0) {
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows: [],
      reason: `${date} 不在当前岗位的可约面试时段内`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'no_matching_schedule',
    };
  }

  if (date !== today) {
    return {
      status: 'available',
      canSchedule: true,
      matchedWindows,
      reason: `${date} 命中岗位配置的面试时段`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'future_schedule_match',
    };
  }

  const latestEnd = matchedWindows
    .map((window) => window.endTime || window.startTime)
    .sort((a, b) => compareTime(a, b))
    .pop();

  if (latestEnd && compareTime(nowTime, latestEnd) > 0) {
    return {
      status: 'unavailable',
      canSchedule: false,
      matchedWindows,
      reason: `当前已超过今天的最晚面试时段 ${latestEnd}`,
      policyNotes: [...basePolicyNotes],
      decisionBasis: 'same_day_after_latest_window',
    };
  }

  return {
    status: 'needs_confirmation',
    canSchedule: null,
    matchedWindows,
    reason: '当前岗位有今天的面试时段，但需要继续调用预约工具确认今天是否还能约上',
    policyNotes: [...basePolicyNotes],
    decisionBasis: 'same_day_window_requires_confirmation',
  };
}

export function buildInterviewPrecheckTool(spongeService: SpongeService): ToolBuilder {
  return () =>
    tool({
      description:
        '面试前置校验。根据岗位 ID 读取真实招聘要求和面试流程，返回：今天/指定日期能不能约、可约时段、备注解析后的字段建议与规则重点。这个工具负责解释岗位规则，不负责真正提交预约。',
      inputSchema,
      execute: async ({ jobId, requestedDate }) => {
        logger.log(`面试前置校验: jobId=${jobId}, requestedDate=${requestedDate ?? 'none'}`);

        const normalizedDate = normalizeRequestedDate(requestedDate);
        if (normalizedDate.error) {
          return {
            success: false,
            errorType: 'invalid_requested_date',
            error: normalizedDate.error,
          };
        }

        try {
          const { jobs } = await spongeService.fetchJobs({
            jobIdList: [jobId],
            pageNum: 1,
            pageSize: 1,
            options: {
              includeBasicInfo: true,
              includeHiringRequirement: true,
              includeInterviewProcess: true,
              includeWorkTime: true,
            },
          });

          const job = jobs[0];
          if (!job?.basicInfo) {
            return {
              success: false,
              errorType: 'job_not_found',
              error: `未找到 jobId=${jobId} 对应的岗位`,
            };
          }

          const analysis = buildJobPolicyAnalysis(job);
          const windows = analysis.interviewWindows;
          const requestedDateCheck = normalizedDate.date
            ? evaluateRequestedDate({
                date: normalizedDate.date,
                windows,
                basePolicyNotes: analysis.highlights.timingHighlights,
              })
            : {
                status: 'needs_confirmation' as const,
                canSchedule: null,
                matchedWindows: windows,
                reason: '未指定日期，本次只返回岗位面试规则与字段建议',
                policyNotes: [...analysis.highlights.timingHighlights],
                decisionBasis: 'date_not_provided' as const,
              };

          const storeInfo = (job.basicInfo?.storeInfo ?? null) as any;

          return {
            success: true,
            job: {
              jobId,
              brandName: normalizePolicyText(job.basicInfo.brandName),
              storeName: normalizePolicyText(storeInfo?.storeName),
              jobName: normalizePolicyText(job.basicInfo.jobName || job.basicInfo.jobNickName),
            },
            interview: {
              method: analysis.interviewMeta.method,
              address: analysis.interviewMeta.address,
              demand: analysis.interviewMeta.demand,
              scheduleWindows: windows,
              requestedDate: normalizedDate.date,
              requestedDateStatus: requestedDateCheck.status,
              canScheduleOnRequestedDate: requestedDateCheck.canSchedule,
              requestedDateReason: requestedDateCheck.reason,
              requestedDateMatchedWindows: requestedDateCheck.matchedWindows,
              requestedDateDecisionBasis: requestedDateCheck.decisionBasis,
              policyNotes: requestedDateCheck.policyNotes,
            },
            requirements: analysis.normalizedRequirements,
            policyHighlights: {
              requirementHighlights: analysis.highlights.requirementHighlights,
              timingHighlights: analysis.highlights.timingHighlights,
            },
            fieldGuidance: {
              ...analysis.fieldGuidance,
              fieldSignals: analysis.fieldGuidance.fieldSignals,
              sourceSummary: dedupeStrings(
                analysis.fieldGuidance.fieldSignals.map(
                  (signal) => `${signal.field} <- ${signal.sourceField}`,
                ),
              ),
            },
          };
        } catch (err) {
          logger.error('面试前置校验失败', err);
          return {
            success: false,
            errorType: 'precheck_failed',
            error: `面试前置校验失败: ${err instanceof Error ? err.message : '未知错误'}`,
          };
        }
      },
    });
}
