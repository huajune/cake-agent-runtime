import type { JobDetail } from '@sponge/sponge.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import { buildJobPolicyAnalysis } from '@tools/job-list/job-policy-parser';
import { formatSalarySummary } from '@tools/job-list/brand-stores.util';
import { formatSettlementSummary } from '@tools/job-list/salary-settlement.util';
import { composeShiftTimeText } from '@tools/job-list/format-shift-time.util';
import { extractWelfareFacts } from '@tools/job-list/welfare-facts.util';
import { inferStudentRequirement } from '@tools/job-list/render.util';

/**
 * `basicInfo.storeInfo` 在领域契约里是 raw `Record<string, unknown>`（海绵按门店透传），
 * 这里声明工具实际读取的字段视图。仅用于类型断言，不做运行时转换。
 */
export type StoreInfoView = {
  storeName?: string;
  storeAddress?: string;
  storeCityName?: string;
  storeRegionName?: string;
  latitude?: unknown;
  longitude?: unknown;
};

/**
 * `_distanceKm` 是 **job-list 工具写上去的合成标注**（海绵不返回）：拿到候选人坐标后按 haversine
 * 算出门店距离回写到岗位对象，供排序/半径过滤/摘要读取。`JobDetail` 的 catchall 把它读成
 * `unknown`，这里给读写两侧一个显式契约。
 */
export type JobWithDistance = JobDetail & { _distanceKm?: number };

/**
 * 海绵岗位 → 会话岗位记忆的规范化摘要（候选池 / 已展示岗位 / 焦点岗位共用同一形状）。
 *
 * job-list 与 precheck 是仅有的两个海绵岗位入口：前者投影整批召回结果进候选池，后者把
 * 校验通过的单个岗位登记为工具确权焦点。两处必须走同一映射，记忆里才不会出现形状分叉。
 */
export function mapJobsToRecommendedSummaries(jobs: JobDetail[]): RecommendedJobSummary[] {
  return jobs.map((job) => {
    const policy = buildJobPolicyAnalysis(job);
    const ageRequirement = policy.normalizedRequirements.ageRequirement;
    const educationRequirement = policy.normalizedRequirements.educationRequirement;
    const healthCertificateRequirement = policy.normalizedRequirements.healthCertificateRequirement;
    const hasWelfarePayload =
      job.welfare !== null && typeof job.welfare === 'object' && !Array.isArray(job.welfare);
    const welfare = hasWelfarePayload ? extractWelfareFacts(job.welfare) : null;
    // storeInfo 在领域契约里是 raw Record：按预期形状断言后直接透传，不做运行时转换
    // （与 candidate-card.util.ts 同一写法，缺字段落 undefined → `?? null`）。
    const storeInfo = job.basicInfo.storeInfo as StoreInfoView | undefined;
    const distanceKm = (job as JobWithDistance)._distanceKm;

    return {
      jobId: job.basicInfo.jobId,
      brandName: job.basicInfo.brandName ?? null,
      jobName: job.basicInfo.jobName ?? null,
      storeName: storeInfo?.storeName ?? null,
      storeAddress: storeInfo?.storeAddress ?? null,
      cityName: storeInfo?.storeCityName ?? null,
      regionName: storeInfo?.storeRegionName ?? null,
      laborForm: job.basicInfo.laborForm ?? null,
      partTimeJobType: job.basicInfo.partTimeJobType ?? null,
      salaryDesc: formatSalarySummary(job),
      settlementSummary: formatSettlementSummary(job),
      shiftSummary: composeShiftTimeText(job.workTime),
      jobCategoryName: job.basicInfo.jobCategoryName ?? null,
      ageRequirement: ageRequirement && ageRequirement !== '不限' ? ageRequirement : null,
      educationRequirement:
        educationRequirement && educationRequirement !== '不限' ? educationRequirement : null,
      healthCertificateRequirement:
        healthCertificateRequirement && healthCertificateRequirement !== '未明确要求'
          ? healthCertificateRequirement
          : null,
      studentRequirement: inferStudentRequirement(policy),
      resumeRequired: policy.fieldGuidance.fieldSignals.some(
        (signal) => signal.field === '简历附件',
      ),
      distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
      welfareFacts: welfare
        ? {
            meals: welfare.meals,
            accommodation: welfare.accommodation,
            hasTrafficAllowance: welfare.hasTrafficAllowance,
            hasPromotionWelfare: welfare.hasPromotionWelfare,
            otherWelfareItems: welfare.otherWelfareItems
              .slice(0, 5)
              .map((item) => item.slice(0, 120)),
          }
        : null,
    };
  });
}
