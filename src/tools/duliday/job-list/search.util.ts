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
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';
import {
  isFullTimeLaborForm,
  isHardFilteredLaborForm,
  isSeasonalLaborForm,
  matchesLaborForm,
  sanitizeLaborFormForDisplay,
} from '@memory/facts/labor-form';

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

/* eslint-disable @typescript-eslint/no-explicit-any */

export function scoreJobAgainstRequestedCategories(job: any, jobCategoryList: string[]): number {
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
 * 候选人输入的品牌别名里常见的"门店/分店"通用后缀。
 * 匹配时优先剥掉这些后缀再做 forward substring，避免改成裸的双向 `includes` 把
 * 含相同字根的无关 alias（如"汉堡不错"匹到"汉堡"）也算成命中。
 */
const ALIAS_GENERIC_SUFFIXES = ['店面', '分店', '总店', '门店', '专卖店', '旗舰店', '店'];

function stripAliasGenericSuffix(alias: string): string {
  for (const suffix of ALIAS_GENERIC_SUFFIXES) {
    if (alias.length > suffix.length && alias.endsWith(suffix)) {
      return alias.slice(0, -suffix.length);
    }
  }
  return alias;
}

/**
 * 候选人明确品牌意向（brandAliasList 非空）时，把结果硬过滤到该意向品牌。
 *
 * 历史 badcase bb012h5c：候选人找"大米先生"，结果回了"史伟莎销售/消杀员"等
 * 不相关品牌，Agent 跨品牌推。原因是 sponge 后端在某些场景下会做模糊匹配返回
 * 非精确品牌，或 LLM 把多个品牌一起塞了 brandAliasList。
 *
 * 匹配策略：对每个 alias 走两次 forward `brandName.includes(...)`：
 * 1. 原始 alias
 * 2. 剥掉常见门店后缀后的 alias（"肯德基店" → "肯德基"，让品牌 "肯德基" 也能命中）
 *
 * 故意**不**做裸的 `alias.includes(brandName)` 反向匹配——那会让 "汉堡不错" 这类
 * 噪声 alias 误伤掉以 "汉堡" 开头的品牌（review feedback：reverse direction 在
 * brandName 短时存在误伤风险）。
 */
export function filterJobsToRequestedBrands(jobs: any[], brandAliasList: string[]): any[] {
  if (!Array.isArray(brandAliasList) || brandAliasList.length === 0) return jobs;
  const aliases = brandAliasList
    .map((alias) => normalizeKeyword(alias))
    .filter((alias) => alias.length > 0);
  if (aliases.length === 0) return jobs;
  return jobs.filter((job) => {
    const brandName = normalizeKeyword(job?.basicInfo?.brandName);
    if (!brandName) return false;
    return aliases.some((alias) => {
      if (brandName.includes(alias)) return true;
      const stripped = stripAliasGenericSuffix(alias);
      return stripped !== alias && brandName.includes(stripped);
    });
  });
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
  jobs: any[],
  constraint: CandidateScheduleConstraint | undefined,
): {
  jobs: any[];
  excluded: Array<{ jobId: number | null; brandName: string | null; reason: string }>;
} {
  const excluded: Array<{ jobId: number | null; brandName: string | null; reason: string }> = [];
  const kept: any[] = [];

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

export interface LaborFormFilterResult {
  /** 是否实际启用了硬过滤。 */
  applied: boolean;
  jobs: any[];
  excluded: Array<{ jobId: number | null; brandName: string | null; laborForm: string | null }>;
}

/**
 * 把候选人想要的用工形式映射成"保留谓词"。返回 null 表示不做硬过滤（软处理）。
 *
 * 硬过滤集：
 * - 全职 → 只保留 laborForm==全职（全职必须岗位字段显式背书）；
 * - 兼职（统称）→ 剔除全职，保留所有非全职（含细分 / 无 laborForm 的默认按兼职）；
 * - 暑假工 / 寒假工（季节性）→ laborForm 严格相等（季节可用性必须字段背书）。
 *
 * 软处理（返回 null，不剔除，仅照字段如实介绍）：
 * - 小时工 / 兼职+ —— 兼职内部细分，laborForm 字段稀疏，硬过滤易误伤。
 */
function buildLaborFormKeepPredicate(
  wanted: string | null | undefined,
): ((job: any) => boolean) | null {
  // 仅硬过滤集（全职/兼职/暑假工/寒假工）构造谓词；其余（小时工/兼职+）软处理返回 null。
  if (!isHardFilteredLaborForm(wanted)) return null;
  if (isFullTimeLaborForm(wanted)) {
    return (job) => isFullTimeLaborForm(job?.basicInfo?.laborForm);
  }
  if (wanted === '兼职') {
    // 非全职即兼职：无 laborForm 的岗位默认视为兼职类，予以保留。
    return (job) => !isFullTimeLaborForm(job?.basicInfo?.laborForm);
  }
  if (isSeasonalLaborForm(wanted)) {
    return (job) => matchesLaborForm(job?.basicInfo?.laborForm, wanted);
  }
  return null;
}

/**
 * 按候选人想要的用工形式过滤岗位（仅对全职 / 兼职统称 / 季节性硬过滤；小时工/兼职+ 软处理）。
 *
 * 剔除项附岗位实际 laborForm，便于上层如实解释（如"附近这几家都是兼职岗，没有全职"）。
 *
 * 设计动机：
 * - badcase 6a32317a：候选人问"廊坊有没有暑假工"，Agent 零查岗就承诺"有"，实际整城无暑假工。
 * - 全职放开后，全职/兼职可用性同理必须由岗位 laborForm 字段背书，不能软推断。
 */
export function applyLaborFormConstraint(
  jobs: any[],
  wanted: string | null | undefined,
): LaborFormFilterResult {
  const keep = buildLaborFormKeepPredicate(wanted);
  if (!keep) {
    return { applied: false, jobs, excluded: [] };
  }

  const excluded: LaborFormFilterResult['excluded'] = [];
  const kept: any[] = [];

  for (const job of jobs) {
    if (keep(job)) {
      kept.push(job);
    } else {
      excluded.push({
        jobId: typeof job?.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null,
        brandName: typeof job?.basicInfo?.brandName === 'string' ? job.basicInfo.brandName : null,
        laborForm: sanitizeLaborFormForDisplay(job?.basicInfo?.laborForm),
      });
    }
  }

  return { applied: true, jobs: kept, excluded };
}

export function filterJobsByRequestedCategories(jobs: any[], jobCategoryList: string[]): any[] {
  return jobs
    .map((job) => ({ job, score: scoreJobAgainstRequestedCategories(job, jobCategoryList) }))
    .filter(({ score }) => score >= 6)
    .sort((a, b) => b.score - a.score)
    .map(({ job }) => job);
}

/* eslint-enable @typescript-eslint/no-explicit-any */
