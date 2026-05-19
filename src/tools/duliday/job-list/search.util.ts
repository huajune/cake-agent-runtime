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
 * 候选人明确品牌意向（brandAliasList 非空）时，把结果硬过滤到该意向品牌。
 *
 * 历史 badcase bb012h5c：候选人找"大米先生"，结果回了"史伟莎销售/消杀员"等
 * 不相关品牌，Agent 跨品牌推。原因是 sponge 后端在某些场景下会做模糊匹配返回
 * 非精确品牌，或 LLM 把多个品牌一起塞了 brandAliasList。
 *
 * 本函数对 jobs[].basicInfo.brandName 做"任一别名出现在品牌名中"的子串匹配，
 * 不匹配的岗位直接剔除。空 brandAliasList 时直通。
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
    return aliases.some((alias) => brandName.includes(alias) || alias.includes(brandName));
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

export function filterJobsByRequestedCategories(jobs: any[], jobCategoryList: string[]): any[] {
  return jobs
    .map((job) => ({ job, score: scoreJobAgainstRequestedCategories(job, jobCategoryList) }))
    .filter(({ score }) => score >= 6)
    .sort((a, b) => b.score - a.score)
    .map(({ job }) => job);
}

/* eslint-enable @typescript-eslint/no-explicit-any */
