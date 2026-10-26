// business-rules: SW-05
import { createOutputRuleFinding } from '../output-rule-catalog';
import { extractPresentedJobs } from '@resolution/job';
import type { RecommendedJobSummary } from '@resolution/job/types';
import { sanitizeLaborFormForDisplay } from '@resolution/labor-form';
import type { RuleContradiction } from '../output-rule.types';
import {
  extractQuantifiedJobFacts,
  isMonthlySalaryFact,
  normalizeQuantifiedJobFact,
} from './job-fact-signals.util';

export interface PartTimeSalaryDisplayContext {
  /** 本轮查岗/预检确认过的岗位（TurnLedger fetchedJobs + attestedFocusJob）。 */
  turnJobs?: readonly RecommendedJobSummary[];
  /** 会话记忆岗位（已展示/候选池/焦点）。 */
  sessionJobs?: readonly RecommendedJobSummary[];
  /** 入口焦点岗位 ID；回复没点名岗位（追问"一个月多少"）时按焦点岗位绑定。 */
  focusJobId?: number | null;
}

/** 兼职岗且标准展示（卡片/摘要主数）按小时计。 */
function isHourlyPartTimeJob(job: RecommendedJobSummary): boolean {
  return (
    sanitizeLaborFormForDisplay(job.laborForm) === '兼职' &&
    normalizeQuantifiedJobFact(job.salaryDesc ?? '').includes('元/时')
  );
}

function resolveBoundJobs(
  text: string,
  context: PartTimeSalaryDisplayContext,
): RecommendedJobSummary[] {
  const seen = new Set<number>();
  const pool = [...(context.turnJobs ?? []), ...(context.sessionJobs ?? [])].filter((job) => {
    if (seen.has(job.jobId)) return false;
    seen.add(job.jobId);
    return true;
  });
  const presented = extractPresentedJobs(text, pool);
  if (presented.length > 0) return presented;
  const focus = pool.find((job) => job.jobId === context.focusJobId);
  return focus ? [focus] : [];
}

/**
 * observe 哨兵：回复绑定的兼职岗按月薪金额介绍，而该岗标准展示口径是时薪
 * （PR #1322 兼职先取基础时薪；2026-10-14 用户裁定：兼职岗即使候选人问月收入也只按时薪与阶梯说明）。
 *
 * 只认封闭形态：回复里出现规整为 `N元/月` 的金额（"月薪3000-4000" / "3000-4000元/月"），
 * 且绑定岗位中有按时薪展示的兼职岗、该金额又不是同回复里其它（非兼职时薪）岗位自己的月薪。
 * "一个月大概三千"等无单位口语不在判定范围。
 */
export function detectPartTimeSalaryDisplayMismatch(
  text: string,
  context: PartTimeSalaryDisplayContext = {},
): RuleContradiction | null {
  const monthlyFacts = extractQuantifiedJobFacts(text).filter((fact) =>
    isMonthlySalaryFact(fact.normalized),
  );
  if (monthlyFacts.length === 0) return null;

  const boundJobs = resolveBoundJobs(text, context);
  const partTimeJobs = boundJobs.filter(isHourlyPartTimeJob);
  if (partTimeJobs.length === 0) return null;

  const otherJobSalaries = boundJobs
    .filter((job) => !isHourlyPartTimeJob(job))
    .map((job) => normalizeQuantifiedJobFact(job.salaryDesc ?? ''));
  const unexplained = monthlyFacts.filter(
    (fact) => !otherJobSalaries.some((salary) => salary.includes(fact.normalized)),
  );
  if (unexplained.length === 0) return null;

  const job = partTimeJobs[0];
  const jobLabel = [job.brandName, job.jobName].filter(Boolean).join(' ') || `jobId ${job.jobId}`;
  return createOutputRuleFinding(
    'part_time_salary_display_mismatch',
    `回复把兼职岗「${jobLabel}」按月薪「${unexplained
      .slice(0, 2)
      .map((fact) => fact.raw)
      .join('、')}」介绍，该岗标准展示口径是时薪「${job.salaryDesc}」`,
  );
}
