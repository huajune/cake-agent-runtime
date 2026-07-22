/**
 * 同品牌"最近门店"聚合 + multi-store warning section 渲染。
 *
 * 从 duliday-job-list.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑变更）：
 * - BrandStoreEntry / BrandNearestStoresGroup 类型
 * - formatSalarySummary：单条岗位的薪资摘要（"24-26 元/时"）
 * - formatBrandStoreDisplayLine：拼成"品牌（门店，距离，班次，薪资，要求）"展示行
 * - buildBrandNearestStoreSummary：jobs[] → BrandNearestStoresGroup[]
 * - getMultiStoreBrandGroups：筛同品牌 ≥2 家的分组
 * - renderMultiStoreBrandWarning：渲染"同品牌多门店"强约束 markdown section
 */

import { normalizeStoreNameForAgent } from '@tools/duliday/job-list/sanitize.util';
import {
  formatDistanceKm,
  type DistanceAnchorPrecision,
} from '@tools/duliday/job-list/distance-render.util';
import { composeShiftTimeText } from '@tools/utils/format-shift-time.util';
import { extractHardRequirements } from '@tools/duliday/job-list/hard-requirements.util';
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BrandStoreEntry {
  storeName: string | null;
  jobId: number;
  /** 岗位职位名（优先取 jobCategoryName，如"普通服务员"、"水果促销员"）。 */
  jobName: string | null;
  distanceKm: number | null;
  wageRange: string | null;
  shiftSummary: string | null;
  requirementSummary: string | null;
  /** 已经按 `品牌 职位（门店，距离，班次，薪资，要求）` 渲染好的话术，禁止 LLM 二次重写。 */
  displayLine: string;
}

export interface BrandNearestStoresGroup {
  brandName: string;
  brandId: number | null;
  /** 总命中门店数（用于"同品牌多门店"判定）。 */
  totalStoreCount: number;
  /** 取前 3 家最近门店；超过的不展示。 */
  nearestStores: BrandStoreEntry[];
}

/** 单条岗位的薪资摘要（"24-26 元/时" / 试工期 / 综合月薪）。 */
export function formatSalarySummary(job: any): string | null {
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

function formatBrandStoreDisplayLine(
  brandName: string,
  jobName: string | null,
  storeName: string | null,
  distanceKm: number | null,
  shiftSummary: string | null,
  wageRange: string | null,
  requirementSummary: string | null,
  distanceAnchor: DistanceAnchorPrecision | null,
): string {
  const parts: string[] = [];
  parts.push(storeName?.trim() || '门店待确认');
  if (distanceKm != null && Number.isFinite(distanceKm)) {
    parts.push(formatDistanceKm(distanceKm, distanceAnchor));
  }
  if (shiftSummary?.trim()) {
    parts.push(shiftSummary.trim());
  }
  if (wageRange?.trim()) {
    parts.push(wageRange.trim());
  }
  if (requirementSummary?.trim()) {
    parts.push(requirementSummary.trim());
  }
  const displayBrand = jobName ? `${brandName} ${jobName}` : brandName;
  return `${displayBrand}（${parts.join('，')}）`;
}

/**
 * `buildBrandNearestStoreSummary` 实际读取的最小 job 字段集。
 * 命名上保持与外部 raw job 一致，作为该函数的自描述契约。
 * `jobSalary` 透传给 `formatSalarySummary`，结构由后者负责。
 */
type BrandSummaryJobInput = {
  basicInfo?: {
    brandName?: unknown;
    brandId?: unknown;
    jobId?: unknown;
    jobCategoryName?: unknown;
    jobName?: unknown;
    storeName?: unknown;
    storeInfo?: { storeName?: unknown; storeCityName?: unknown } | null;
  } | null;
  _distanceKm?: unknown;
  jobSalary?: unknown;
  workTime?: unknown;
  hiringRequirement?: unknown;
};

function formatShiftSummary(job: BrandSummaryJobInput): string | null {
  const shift = composeShiftTimeText(job.workTime);
  return shift || null;
}

function formatRequirementSummary(job: BrandSummaryJobInput): string | null {
  const policy = buildJobPolicyAnalysis(job as any);
  const hr = extractHardRequirements(job as any, policy);
  const parts: string[] = [];
  const age = policy.normalizedRequirements.ageRequirement;
  if (age && age !== '不限') parts.push(age);
  if (hr.gender === 'female') parts.push('仅限女');
  else if (hr.gender === 'male') parts.push('仅限男');
  if (hr.healthCert === 'required_before_interview') parts.push('需健康证');
  else if (hr.healthCert === 'required_before_onboard') parts.push('入职前办健康证');
  return parts.length > 0 ? parts.join('，') : null;
}

/**
 * 同品牌"最近门店"汇总：候选人在某区域有 brand intent 时，
 * 如果同品牌返回多家门店，必须按品牌分组挑距离最近的 1-2 家展示，
 * 否则容易跳过更近的同品牌门店推荐更远的（badcase 70xxcmhy）。
 *
 * 每个 store 同时附带 `displayLine` 固定结构话术，LLM 必须按此转述同品牌多门店，
 * 禁止把多家门店压缩成"有 X 品牌"（badcase laybqxn4）。
 */
export function buildBrandNearestStoreSummary(
  jobs: BrandSummaryJobInput[],
  distanceAnchor: DistanceAnchorPrecision | null = null,
): BrandNearestStoresGroup[] | null {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;

  const buckets = new Map<
    string,
    {
      brandName: string;
      brandId: number | null;
      stores: Array<{
        storeName: string | null;
        jobId: number;
        jobName: string | null;
        distanceKm: number | null;
        wageRange: string | null;
        shiftSummary: string | null;
        requirementSummary: string | null;
      }>;
    }
  >();

  for (const job of jobs) {
    const brandName = job.basicInfo?.brandName;
    if (!brandName || typeof brandName !== 'string') continue;
    const brandId = typeof job.basicInfo?.brandId === 'number' ? job.basicInfo.brandId : null;
    const jobId = typeof job.basicInfo?.jobId === 'number' ? job.basicInfo.jobId : null;
    if (jobId == null) continue;
    const key = `${brandName}__${brandId ?? 'null'}`;
    const bucket = buckets.get(key) ?? { brandName, brandId, stores: [] };
    const rawStoreName =
      typeof job.basicInfo?.storeInfo?.storeName === 'string'
        ? job.basicInfo.storeInfo.storeName
        : typeof job.basicInfo?.storeName === 'string'
          ? job.basicInfo.storeName
          : null;
    const storeCityName =
      typeof job.basicInfo?.storeInfo?.storeCityName === 'string'
        ? job.basicInfo.storeInfo.storeCityName
        : null;
    const storeName = normalizeStoreNameForAgent(rawStoreName, storeCityName);
    const jobName =
      typeof job.basicInfo?.jobCategoryName === 'string'
        ? job.basicInfo.jobCategoryName
        : typeof job.basicInfo?.jobName === 'string'
          ? job.basicInfo.jobName
          : null;
    bucket.stores.push({
      storeName,
      jobId,
      jobName,
      distanceKm:
        typeof job._distanceKm === 'number' ? Math.round(job._distanceKm * 10) / 10 : null,
      wageRange: formatSalarySummary(job),
      shiftSummary: formatShiftSummary(job),
      requirementSummary: formatRequirementSummary(job),
    });
    buckets.set(key, bucket);
  }

  const summary: BrandNearestStoresGroup[] = Array.from(buckets.values())
    .filter((bucket) => bucket.stores.length >= 1)
    .map((bucket) => {
      const sorted = bucket.stores
        .slice()
        .sort((a, b) => {
          if (a.distanceKm == null && b.distanceKm == null) return 0;
          if (a.distanceKm == null) return 1;
          if (b.distanceKm == null) return -1;
          return a.distanceKm - b.distanceKm;
        })
        .slice(0, 3)
        .map((store) => ({
          ...store,
          displayLine: formatBrandStoreDisplayLine(
            bucket.brandName,
            store.jobName,
            store.storeName,
            store.distanceKm,
            store.shiftSummary,
            store.wageRange,
            store.requirementSummary,
            distanceAnchor,
          ),
        }));
      return {
        brandName: bucket.brandName,
        brandId: bucket.brandId,
        totalStoreCount: bucket.stores.length,
        nearestStores: sorted,
      };
    });

  return summary.length > 0 ? summary : null;
}

/** 检测同品牌≥2 家门店的分组，用于在 markdown / queryMeta 上注入强约束。 */
export function getMultiStoreBrandGroups(
  groups: BrandNearestStoresGroup[] | null,
): BrandNearestStoresGroup[] {
  if (!groups || groups.length === 0) return [];
  return groups.filter((group) => group.totalStoreCount >= 2);
}

/**
 * 渲染"同品牌多门店"强约束 section，作为 markdown 顶部置顶提醒。
 * LLM 看到此 section 时，必须按 displayLine 原文转述同品牌门店，不得合并/省略。
 */
export function renderMultiStoreBrandWarning(
  groups: BrandNearestStoresGroup[] | null,
): string | null {
  const multi = getMultiStoreBrandGroups(groups);
  if (multi.length === 0) return null;

  const lines: string[] = [];
  lines.push('## ⚠️ 同品牌多门店');
  lines.push(
    '> 以下品牌返回多家门店。**推荐这些岗位时必须按门店名+距离+班次+薪资+要求逐家区分，禁止只说"有 X 品牌"或把两家合并成一句**。',
  );
  lines.push(
    '> 直接照上方「推荐对话用模板」卡片原文逐条转述（可改成口语化的连接词，但门店名/距离/班次/薪资/要求不得省略）。',
  );
  for (const group of multi) {
    lines.push('');
    lines.push(
      `### ${group.brandName}（共 ${group.totalStoreCount} 家，按距离展示前 ${group.nearestStores.length} 家）`,
    );
    for (const store of group.nearestStores) {
      lines.push(`- ${store.displayLine}（jobId: ${store.jobId}）`);
    }
  }
  return lines.join('\n') + '\n\n';
}

/* eslint-enable @typescript-eslint/no-explicit-any */
