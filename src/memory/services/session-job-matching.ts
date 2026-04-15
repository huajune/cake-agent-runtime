import type { RecommendedJobSummary } from '../types/session-facts.types';
import { splitJobCategorySegments } from '@sponge/job-category.util';

/** 从助手回复里找出本轮真正展示过的岗位。 */
export function extractPresentedJobs(
  assistantText: string,
  candidatePool: RecommendedJobSummary[],
): RecommendedJobSummary[] {
  const normalizedReply = normalizeForMatch(assistantText);
  if (!normalizedReply || candidatePool.length === 0) return [];

  return candidatePool
    .map((job) => ({ job, score: scoreJobReference(job, normalizedReply) }))
    .filter(({ score }) => score >= 5)
    .sort((a, b) => b.score - a.score)
    .map(({ job }) => job)
    .slice(0, 3);
}

/**
 * 根据用户最新一句话锁定焦点岗位。
 * 返回值：
 * - job: 明确锁定
 * - null: 明确清空焦点
 * - undefined: 保持原状
 */
export function resolveCurrentFocusJob(
  userText: string,
  previousPresentedJobs: RecommendedJobSummary[],
  newlyPresentedJobs: RecommendedJobSummary[],
  candidatePool: RecommendedJobSummary[],
): RecommendedJobSummary | null | undefined {
  const normalizedUserText = normalizeForMatch(userText);
  if (!normalizedUserText) return undefined;

  if (isSwitchingPoolIntent(normalizedUserText)) {
    return null;
  }

  const focusIntent = hasFocusIntent(normalizedUserText);
  const presented = dedupeJobsById([...newlyPresentedJobs, ...previousPresentedJobs]);
  const knownJobs = dedupeJobsById([...presented, ...candidatePool]);

  const matchedPresented = pickBestReferencedJob(presented, normalizedUserText);
  if (matchedPresented) return matchedPresented;

  const matchedPool = pickBestReferencedJob(knownJobs, normalizedUserText);
  if (matchedPool) return matchedPool;

  if (focusIntent && presented.length === 1) return presented[0];
  if (focusIntent && knownJobs.length === 1) return knownJobs[0];

  return undefined;
}

/**
 * 当用户最新一句话没有明确锁定岗位时，允许根据助手本轮回复中的强指向内容补锁一次焦点岗位。
 *
 * 典型场景：
 * - 助手发出预约资料模板，明确写出了“应聘门店/应聘岗位”
 * - 用户上一句只是“可以/好的”等弱确认，不足以靠 userText 锁定岗位
 *
 * 只有当助手文本对某个岗位的引用明显强于其他岗位时才返回，避免在多岗位并列介绍时误锁。
 */
export function resolveAssistantAnchoredFocusJob(
  assistantText: string,
  previousPresentedJobs: RecommendedJobSummary[],
  newlyPresentedJobs: RecommendedJobSummary[],
  candidatePool: RecommendedJobSummary[],
): RecommendedJobSummary | null {
  const normalizedAssistantText = normalizeForMatch(assistantText);
  if (!normalizedAssistantText) return null;

  const presented = dedupeJobsById([...newlyPresentedJobs, ...previousPresentedJobs]);
  const knownJobs = dedupeJobsById([...presented, ...candidatePool]);
  return pickDominantReferencedJob(knownJobs, normalizedAssistantText);
}

function scoreJobReference(job: RecommendedJobSummary, normalizedText: string): number {
  let score = 0;

  const storeName = normalizeForMatch(job.storeName);
  const jobName = normalizeForMatch(job.jobName);
  const brandName = normalizeForMatch(job.brandName);
  const laborForm = normalizeForMatch(job.laborForm);
  const salaryDesc = normalizeForMatch(job.salaryDesc);

  if (storeName && normalizedText.includes(storeName)) score += 5;
  if (jobName && normalizedText.includes(jobName)) score += 4;
  score += scoreJobCategoryReference(job.jobCategoryName, normalizedText);
  if (brandName && normalizedText.includes(brandName)) score += 1;
  if (laborForm && normalizedText.includes(laborForm)) score += 1;
  if (salaryDesc && salaryDesc.length >= 4 && normalizedText.includes(salaryDesc)) score += 1;

  return score;
}

function scoreJobCategoryReference(
  jobCategoryName: string | null | undefined,
  normalizedText: string,
): number {
  const normalizedFullCategory = normalizeForMatch(jobCategoryName);
  if (normalizedFullCategory && normalizedText.includes(normalizedFullCategory)) {
    return 4;
  }

  const matchedSegments = splitJobCategorySegments(jobCategoryName)
    .map((segment) => normalizeForMatch(segment))
    .filter(Boolean)
    .filter((segment, index, arr) => arr.indexOf(segment) === index)
    .filter((segment) => normalizedText.includes(segment)).length;

  return Math.min(matchedSegments * 2, 4);
}

function pickBestReferencedJob(
  jobs: RecommendedJobSummary[],
  normalizedUserText: string,
): RecommendedJobSummary | null {
  const scored = jobs
    .map((job) => ({ job, score: scoreJobReference(job, normalizedUserText) }))
    .filter(({ score }) => score >= 4)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  const runnerUp = scored[1];
  if (runnerUp && runnerUp.score === best.score) {
    return null;
  }

  return best.job;
}

function pickDominantReferencedJob(
  jobs: RecommendedJobSummary[],
  normalizedText: string,
): RecommendedJobSummary | null {
  const scored = jobs
    .map((job) => ({ job, score: scoreJobReference(job, normalizedText) }))
    .filter(({ score }) => score >= 8)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < 3) {
    return null;
  }

  return best.job;
}

function dedupeJobsById(jobs: RecommendedJobSummary[]): RecommendedJobSummary[] {
  return jobs.filter(
    (job, index, arr) => arr.findIndex((item) => item.jobId === job.jobId) === index,
  );
}

function hasFocusIntent(normalizedUserText: string): boolean {
  return /(报名|想报|想去|约面|面试|这家|这个|就这家|就这个|那家|那个岗位|这份工作)/.test(
    normalizedUserText,
  );
}

function isSwitchingPoolIntent(normalizedUserText: string): boolean {
  return /(再看看别的|换一批|其他的|还有别的|还有其他|看看别的)/.test(normalizedUserText);
}

function normalizeForMatch(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}
