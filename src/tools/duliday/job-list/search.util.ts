/**
 * duliday_job_list 工具的检索/过滤/排序辅助。
 *
 * 从 duliday-job-list.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑变更）：
 * - haversineDistance：经纬度球面距离
 * - scoreJobAgainstRequestedCategories：候选人意向类目与岗位的相似度评分
 * - filterJobsByRequestedCategories：按类目评分过滤
 * - formatScheduleConstraintLabel：班次硬约束文本化
 * - applyScheduleConstraint：按候选人班次硬约束过滤岗位并标记 _scheduleSemantic
 */

import {
  classifyScheduleSemantic,
  matchScheduleConstraint,
  type CandidateScheduleConstraint,
  type ScheduleSemantic,
} from '@tools/utils/schedule-semantic.util';
import { normalizeForBrandMatch } from '@resolution/brand/brand-normalize';
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';
import { extractHardRequirements } from '@tools/duliday/job-list/hard-requirements.util';
import {
  isHardFilteredLaborForm,
  isJobAxisLaborForm,
  isPartTimeFamilyLaborForm,
  isPartTimeJobType,
  matchesLaborForm,
  sanitizeLaborFormForDisplay,
} from '@memory/facts/labor-form';
import type { JobDetail } from '@sponge/sponge.types';

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine 公式：计算两个经纬度之间的距离（km） */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeKeyword(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9一-龥]/g, '');
}

export function scoreJobAgainstRequestedCategories(
  job: JobDetail,
  jobCategoryList: string[],
): number {
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

/**
 * 品牌等值过滤目标：入口标准化（§8.2）后的品牌 ID / 标准名集合。
 */
export interface BrandEqualityTarget {
  brandIds: number[];
  canonicalNames: string[];
}

function matchesBrandTarget(job: JobDetail, target: BrandEqualityTarget): boolean {
  const jobBrandId = typeof job?.basicInfo?.brandId === 'number' ? job.basicInfo.brandId : null;
  if (jobBrandId != null && target.brandIds.includes(jobBrandId)) return true;
  const jobBrandName = normalizeForBrandMatch(
    typeof job?.basicInfo?.brandName === 'string' ? job.basicInfo.brandName : '',
  );
  if (!jobBrandName) return false;
  return target.canonicalNames.some((name) => normalizeForBrandMatch(name) === jobBrandName);
}

/**
 * 候选人明确品牌意向时，把结果硬过滤到该意向品牌（历史 badcase bb012h5c：
 * 找"大米先生"却被回了"史伟莎"等无关品牌——sponge 在某些场景做模糊匹配）。
 *
 * 入口标准化（§8.2）落地后过滤条件是品牌 ID/标准品牌名，本地过滤退化为**等值比较**
 * （§5.1：私有包含匹配策略 normalizeKeyword + 单向 includes 已废弃）。
 */
export function filterJobsToAppliedBrands(
  jobs: JobDetail[],
  target: BrandEqualityTarget,
): JobDetail[] {
  if (target.brandIds.length === 0 && target.canonicalNames.length === 0) return jobs;
  return jobs.filter((job) => matchesBrandTarget(job, target));
}

/**
 * exclude 模式的本地后过滤（§8.1）：Duliday 岗位接口没有品牌排除参数，只能召回后剔除。
 * 受分页扫描上限影响可能出现召回空洞（已知局限，queryMeta 如实记录 filterMode=exclude）。
 */
export function filterJobsExcludingBrands(
  jobs: JobDetail[],
  target: BrandEqualityTarget,
): JobDetail[] {
  if (target.brandIds.length === 0 && target.canonicalNames.length === 0) return jobs;
  return jobs.filter((job) => !matchesBrandTarget(job, target));
}

export function formatScheduleConstraintLabel(c: CandidateScheduleConstraint): string {
  const parts: string[] = [];
  if (c.onlyWeekends) parts.push('只周末');
  if (c.onlyEvenings) parts.push('只晚班');
  if (c.onlyMornings) parts.push('只早班');
  if (typeof c.maxDaysPerWeek === 'number') parts.push(`每周最多 ${c.maxDaysPerWeek} 天`);
  return parts.join(' / ') || '未明确';
}

/**
 * 按候选人班次硬约束过滤岗位 + 给每个保留岗位标 scheduleSemantic。
 * 不兼容岗位被剔除并附原因。
 */
export function applyScheduleConstraint(
  jobs: JobDetail[],
  constraint: CandidateScheduleConstraint | undefined,
): {
  jobs: JobDetail[];
  excluded: Array<{ jobId: number | null; brandName: string | null; reason: string }>;
} {
  const excluded: Array<{ jobId: number | null; brandName: string | null; reason: string }> = [];
  const kept: JobDetail[] = [];

  for (const job of jobs) {
    const analysis = buildJobPolicyAnalysis(job);
    const workTimeText = job.workTime ? JSON.stringify(job.workTime) : '';
    const semantics: ScheduleSemantic[] = classifyScheduleSemantic({
      workTimeText,
      interviewRemark: analysis.normalizedRequirements.interviewRemark,
      requirementRemark: analysis.normalizedRequirements.remark,
    });
    job._scheduleSemantic = semantics;
    if (!constraint) {
      kept.push(job);
      continue;
    }
    const result = matchScheduleConstraint(semantics, constraint);
    if (result.matched) {
      kept.push(job);
    } else {
      excluded.push({
        jobId: typeof job.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null,
        brandName: typeof job.basicInfo?.brandName === 'string' ? job.basicInfo.brandName : null,
        reason: result.reason || '与候选人班次硬约束冲突',
      });
    }
  }

  return { jobs: kept, excluded };
}

export interface StudentIdentityFilterResult {
  applied: boolean;
  jobs: JobDetail[];
  excluded: Array<{ jobId: number | null; brandName: string | null; reason: string }>;
}

/**
 * 按候选人学生身份硬过滤岗位（先筛后推，badcase fazpqciu：拉瓦萨「不接受学生」
 * 岗被推荐并收完整张报名表，候选人填完"学生"才被 precheck 拒绝）。
 *
 * 只在 candidateIsStudent === true 时过滤（剔除 student='social_only' 的岗位）：
 * - true 来自候选人明确自报，可信；
 * - false 有抽取污染史（badcase 6a673402：evidence 自证"不填"仍落 false），
 *   不能据此隐藏"仅限学生"岗位，false/null 一律不过滤；
 * - 身份未知时的处理走推荐卡片披露 + 收资前单问（prompt 层先筛后推规则）。
 */
export function applyStudentIdentityConstraint(
  jobs: JobDetail[],
  candidateIsStudent: boolean | null,
): StudentIdentityFilterResult {
  if (candidateIsStudent !== true) {
    return { applied: false, jobs, excluded: [] };
  }
  const excluded: StudentIdentityFilterResult['excluded'] = [];
  const kept: JobDetail[] = [];
  for (const job of jobs) {
    const policy = buildJobPolicyAnalysis(job);
    const hr = extractHardRequirements(job, policy);
    if (hr.student === 'social_only') {
      excluded.push({
        jobId: typeof job?.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null,
        brandName: typeof job?.basicInfo?.brandName === 'string' ? job.basicInfo.brandName : null,
        reason: '岗位不接受学生，与候选人已明确的学生身份冲突',
      });
    } else {
      kept.push(job);
    }
  }
  return { applied: true, jobs: kept, excluded };
}

export interface LaborFormFilterResult {
  /** 是否实际启用了硬过滤。 */
  applied: boolean;
  jobs: JobDetail[];
  excluded: Array<{
    jobId: number | null;
    brandName: string | null;
    laborForm: string | null;
    partTimeJobType: string | null;
  }>;
  /**
   * 严格匹配清空召回后按兼职家族放宽命中。为 true 时 jobs 里是兼职类型不同的
   * 同形态岗位，上层必须提示模型按岗位真实 用工形式/兼职类型 介绍，不得包装成候选人原话。
   */
  relaxedToFamily: boolean;
}

/**
 * 把候选人想要的用工形式映射成"保留谓词"。返回 null 表示不做硬过滤（未提供合法偏好）。
 *
 * 业务口径：候选人指定任一合法用工形式时，按岗位层级结构化字段匹配——
 * 全职/兼职 比对 `laborForm` 父级；小时工/寒暑假工 比对 `laborForm=兼职 && partTimeJobType`。
 */
function buildLaborFormKeepPredicate(
  wanted: string | null | undefined,
): ((job: JobDetail) => boolean) | null {
  if (!isHardFilteredLaborForm(wanted)) return null;
  return (job) =>
    matchesLaborForm(job?.basicInfo?.laborForm, job?.basicInfo?.partTimeJobType, wanted);
}

/**
 * 按候选人想要的用工形式过滤岗位（层级严格匹配，见 matchesLaborForm）。
 *
 * 严格匹配清空召回、且候选人要的是兼职形态（暑假工除外，其口径是如实告知没岗）时，
 * 按兼职家族放宽重筛：细分标签在岗位轴上分布不均（badcase 6a334d26），
 * 不能因为附近兼职岗都没标候选人要的细分就一刀切"附近没岗"。放宽只扩召回，
 * 介绍口径仍按岗位真实 用工形式/兼职类型（relaxedToFamily 信号交由上层提示模型）。
 *
 * 剔除项附岗位实际 laborForm/partTimeJobType，便于上层如实解释
 * （如"附近这几家是常规兼职岗，没有暑假工"）。
 */
export function applyLaborFormConstraint(
  jobs: JobDetail[],
  wanted: string | null | undefined,
): LaborFormFilterResult {
  const keep = buildLaborFormKeepPredicate(wanted);
  if (!keep) {
    return { applied: false, jobs, excluded: [], relaxedToFamily: false };
  }

  const partition = (predicate: (job: JobDetail) => boolean) => {
    const excluded: LaborFormFilterResult['excluded'] = [];
    const kept: JobDetail[] = [];
    for (const job of jobs) {
      if (predicate(job)) {
        kept.push(job);
      } else {
        excluded.push({
          jobId: typeof job?.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null,
          brandName: typeof job?.basicInfo?.brandName === 'string' ? job.basicInfo.brandName : null,
          laborForm: sanitizeLaborFormForDisplay(job?.basicInfo?.laborForm),
          partTimeJobType: sanitizeLaborFormForDisplay(job?.basicInfo?.partTimeJobType),
        });
      }
    }
    return { kept, excluded };
  };

  const strict = partition(keep);
  if (strict.kept.length > 0 || !isPartTimeFamilyLaborForm(wanted) || wanted === '暑假工') {
    return { applied: true, jobs: strict.kept, excluded: strict.excluded, relaxedToFamily: false };
  }

  // 家族放宽的岗位侧判定严格按父级 laborForm=兼职；不认历史扁平脏数据
  //（laborForm=小时工 等异常由 collectLaborFormAnomalies 暴露，走改数据）。
  const family = partition(
    (job) => sanitizeLaborFormForDisplay(job?.basicInfo?.laborForm) === '兼职',
  );
  if (family.kept.length === 0) {
    return { applied: true, jobs: [], excluded: strict.excluded, relaxedToFamily: false };
  }
  return { applied: true, jobs: family.kept, excluded: family.excluded, relaxedToFamily: true };
}

export interface LaborFormAnomaly {
  jobId: number | null;
  brandName: string | null;
  laborForm: string | null;
  partTimeJobType: string | null;
  reason:
    | 'labor_form_not_in_axis' // laborForm 有值但不在 {全职,兼职}（典型：细分值写在 laborForm 上的旧数据）
    | 'part_time_job_type_not_in_axis' // partTimeJobType 有值但不在 {寒假工,暑假工,小时工}
    | 'full_time_with_part_time_job_type'; // 全职岗却带兼职类型，两字段矛盾
}

/**
 * 收集不符合新契约的岗位用工形式数据，供工具层暴露（logger + queryMeta 落库）。
 *
 * 匹配层（matchesLaborForm / 家族放宽）不兜底这些脏数据——它们匹配不上是**预期行为**；
 * 本函数的职责是让问题可见，推动上游改数据本身。
 */
export function collectLaborFormAnomalies(jobs: JobDetail[]): LaborFormAnomaly[] {
  const anomalies: LaborFormAnomaly[] = [];
  for (const job of jobs) {
    const laborForm = sanitizeLaborFormForDisplay(job?.basicInfo?.laborForm);
    const partTimeJobType = sanitizeLaborFormForDisplay(job?.basicInfo?.partTimeJobType);
    let reason: LaborFormAnomaly['reason'] | null = null;
    if (laborForm !== null && !isJobAxisLaborForm(laborForm)) {
      reason = 'labor_form_not_in_axis';
    } else if (partTimeJobType !== null && !isPartTimeJobType(partTimeJobType)) {
      reason = 'part_time_job_type_not_in_axis';
    } else if (laborForm === '全职' && partTimeJobType !== null) {
      reason = 'full_time_with_part_time_job_type';
    }
    if (!reason) continue;
    anomalies.push({
      jobId: typeof job?.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null,
      brandName: typeof job?.basicInfo?.brandName === 'string' ? job.basicInfo.brandName : null,
      laborForm,
      partTimeJobType,
      reason,
    });
  }
  return anomalies;
}

export function filterJobsByRequestedCategories(
  jobs: JobDetail[],
  jobCategoryList: string[],
): JobDetail[] {
  return jobs
    .map((job) => ({ job, score: scoreJobAgainstRequestedCategories(job, jobCategoryList) }))
    .filter(({ score }) => score >= 6)
    .sort((a, b) => b.score - a.score)
    .map(({ job }) => job);
}

/**
 * 泛化统称类岗位工种词——候选人口语里的「店员/员工/工作人员」并不是 sponge 岗位分类轴上的
 * 具体工种，而是「门店里干活的人」的笼统称呼。把它们塞进 jobCategoryList 会做 API 精确类目
 * 过滤，几乎必然 0 命中（商超/连锁的真实工种是收银员/理货员/促销员/保洁员…，没有叫「店员」
 * 的类目），且本地关键词兜底（{@link filterJobsByRequestedCategories}）也匹配不上——「店员」
 * 不是任何真实工种名的子串，两字词又够不到字符重叠兜底。结果是明明有同品牌同商圈在招岗位，
 * 却因这一个泛化词被误判「查无」。
 *
 * 生产 badcase 实证（chat 6a66d888，果蔬好·天津）：候选人「我想应聘店员」→ jobCategoryList=
 * ["店员"] → 果蔬好乐提港店 6 个真实岗位（收银员/理货员/促销员/保洁员）被过滤为空，坐标放宽
 * 到 30km 仍空。剥离「店员」后由品牌 + 城市/坐标继续召回，即可正常返回这些岗位。
 *
 * 只剥离「纯泛化统称」——它们语义上等价于「员工」，任何品牌都不会把岗位分类命名成这些词；
 * 「收银员/分拣员/骑手」等具体工种一律不动。
 */
export const GENERIC_POSITION_UMBRELLA_WORDS = new Set<string>([
  '店员',
  '店员岗',
  '门店店员',
  '员工',
  '普通员工',
  '工作人员',
]);

/**
 * 从 jobCategoryList 中剥离泛化统称词（{@link GENERIC_POSITION_UMBRELLA_WORDS}）。
 * 与 stripLaborFormFromCategories 同形：返回剥离后的 cleaned 与被剥离的 removed，供观测日志/queryMeta 使用。
 */
export function stripGenericPositionUmbrella(categories: readonly string[]): {
  cleaned: string[];
  removed: string[];
} {
  const cleaned: string[] = [];
  const removed: string[] = [];
  for (const raw of categories) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    if (GENERIC_POSITION_UMBRELLA_WORDS.has(trimmed)) {
      removed.push(trimmed);
    } else {
      cleaned.push(trimmed);
    }
  }
  return { cleaned, removed };
}
