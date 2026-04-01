import type { RecommendedJobSummary } from '../types/session-facts.types';

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

function scoreJobReference(job: RecommendedJobSummary, normalizedText: string): number {
  let score = 0;

  const storeName = normalizeForMatch(job.storeName);
  const jobName = normalizeForMatch(job.jobName);
  const brandName = normalizeForMatch(job.brandName);
  const jobCategoryName = normalizeForMatch(job.jobCategoryName);
  const laborForm = normalizeForMatch(job.laborForm);
  const salaryDesc = normalizeForMatch(job.salaryDesc);

  if (storeName && normalizedText.includes(storeName)) score += 5;
  if (jobName && normalizedText.includes(jobName)) score += 4;
  if (jobCategoryName && normalizedText.includes(jobCategoryName)) score += 2;
  if (brandName && normalizedText.includes(brandName)) score += 1;
  if (laborForm && normalizedText.includes(laborForm)) score += 1;
  if (salaryDesc && salaryDesc.length >= 4 && normalizedText.includes(salaryDesc)) score += 1;

  return score;
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
