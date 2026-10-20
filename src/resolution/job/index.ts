import { splitJobCategorySegments } from '@sponge/job-category.util';
import type { JobStudentTier, RecommendedJobSummary } from './types';

export type { JobStudentTier, RecommendedJobSummary } from './types';

/** 在校学生能否安排某岗位的结论；`unrecorded` 只出现在缺档位的历史岗位记忆上。 */
export type StudentEligibility =
  | 'accepts_student'
  | 'rejects_student'
  | 'field_empty'
  | 'unrecorded';

/**
 * 社会身份档位 → 在校学生资格结论。查岗侧学生硬过滤、提示词逐岗结论与出站哨兵共用这一张映射，
 * 不得各自再按文本推断。缺档（历史记录）返回 `unrecorded`，不回落到 studentRequirement 文本。
 */
export function classifyStudentEligibility(
  tier: JobStudentTier | null | undefined,
): StudentEligibility {
  switch (tier) {
    case 'any':
    case 'student_only':
      return 'accepts_student';
    case 'social_only':
    case 'second_job_only':
      return 'rejects_student';
    case 'unspecified':
      return 'field_empty';
    default:
      return 'unrecorded';
  }
}

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

  // 唯一岗场景：候选池与已展示岗都只有同一个岗位时焦点不存在歧义，直接锁定。单岗展示
  // 话术常凑不到 8 分打分门槛（门店 5 + 品牌 1 + 薪资 1 = 7），焦点悬空会让后续详情追问
  // 失去 jobId 接地。
  if (presented.length === 1 && knownJobs.length === 1) return presented[0];

  return pickDominantReferencedJob(knownJobs, normalizedAssistantText);
}

function scoreJobReference(job: RecommendedJobSummary, normalizedText: string): number {
  let score = 0;

  const jobName = normalizeForMatch(job.jobName);
  const brandName = normalizeForMatch(job.brandName);
  const laborForm = normalizeForMatch(job.laborForm);
  const partTimeJobType = normalizeForMatch(job.partTimeJobType);
  const salaryDesc = normalizeForMatch(job.salaryDesc);

  if (matchesStoreReference(job, normalizedText)) score += 5;
  if (jobName && normalizedText.includes(jobName)) score += 4;
  score += scoreJobCategoryReference(job.jobCategoryName, normalizedText);
  if (brandName && normalizedText.includes(brandName)) score += 1;
  if (laborForm && normalizedText.includes(laborForm)) score += 1;
  if (partTimeJobType && partTimeJobType !== laborForm && normalizedText.includes(partTimeJobType))
    score += 1;
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

/** 只规整海绵门店元数据；不把城市、负责人或门店编码当成门店指称。 */
function storeReferenceNames(job: RecommendedJobSummary): string[] {
  const raw = job.storeName?.normalize('NFKC').trim() ?? '';
  const withoutCode = raw.replace(/(?:DT)?-[A-Z]{2,6}\d{3,}$/iu, '');
  const parts = withoutCode.split('-');
  const city = normalizeForMatch(job.cityName).replace(/市$/u, '');
  if (city && normalizeForMatch(parts[0]).replace(/市$/u, '') === city) {
    parts.shift();
    if (parts.length >= 2 && /^[\u4e00-\u9fa5]{2,4}$/u.test(parts[0])) parts.shift();
  }
  const name = parts.join('-');
  return [raw, name, name.replace(/店$/u, '')]
    .map(normalizeForMatch)
    .filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index);
}

function matchesStoreReference(job: RecommendedJobSummary, normalizedText: string): boolean {
  return storeReferenceNames(job).some((name) => normalizedText.includes(name));
}

/** 模型提取的点名原文须整体对上品牌或门店别名，不能只因品牌相同就吞掉未知店名。 */
export function matchesExplicitStoreReference(job: RecommendedJobSummary, text: string): boolean {
  const normalized = normalizeForMatch(text);
  const brand = normalizeForMatch(job.brandName);
  if (!normalized) return false;
  if (brand && normalized === brand) return true;
  const store = brand && normalized.startsWith(brand) ? normalized.slice(brand.length) : normalized;
  return storeReferenceNames(job).some((name) => name === normalized || name === store);
}

/** 品牌与门店联合约束；冲突返回双方候选供澄清，不能用门店分数覆盖显式品牌。 */
export function findStoreReferencedJobs(
  jobs: readonly RecommendedJobSummary[],
  userText: string,
): RecommendedJobSummary[] {
  const text = normalizeForMatch(userText);
  const unique = dedupeJobsById([...jobs]);
  const brandMatches = unique.filter((job) => {
    const brand = normalizeForMatch(job.brandName);
    return brand && text.includes(brand);
  });
  const scored = unique.map((job) => ({
    job,
    // 完整/更长门店名优先，避免「万达」短别名与「万达广场店」同分。
    score: Math.max(
      0,
      ...storeReferenceNames(job)
        .filter((name) => text.includes(name))
        .map((name) => name.length),
    ),
  }));
  const bestScore = Math.max(0, ...scored.map(({ score }) => score));
  const storeMatches = scored
    .filter(({ score }) => score > 0 && score === bestScore)
    .map(({ job }) => job);
  if (brandMatches.length === 0) return storeMatches;
  if (storeMatches.length === 0) return brandMatches;
  const joint = storeMatches.filter((job) =>
    brandMatches.some((brandJob) => brandJob.jobId === job.jobId),
  );
  return joint.length > 0 ? joint : dedupeJobsById([...brandMatches, ...storeMatches]);
}

export function pickBestReferencedJob(
  jobs: readonly RecommendedJobSummary[],
  userText: string,
  scope: 'job' | 'store' = 'job',
): RecommendedJobSummary | null {
  if (scope === 'store') {
    const matches = findStoreReferencedJobs(jobs, userText);
    return matches.length === 1 ? matches[0] : null;
  }
  const normalizedUserText = normalizeForMatch(userText);
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

/**
 * 岗位 ID 归一：只接受正整数或纯数字串，其余（0、负数、小数、含空白或非数字）一律 null。
 *
 * 岗位 ID 从海绵工单/岗位接口进来时形态不定（number 或 string），而它同时是 provenance
 * 闸门的钥匙——两处各写一份判据就会出现「Prompt 里看得见、闸门不认」的错位。
 */
export function normalizeJobId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : null;
  }
  return null;
}
