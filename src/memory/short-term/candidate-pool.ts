import { RecommendedJobSummarySchema, type RecommendedJobSummary } from '@resolution/job/types';

const MAX_POOL_SIZE = 30;
const FULL_SUMMARY_COUNT = 10;

/** 前十个保留完整摘要；其余仅保留岗位定位、出处和资格字段，细节按 jobId 实时补查。 */
export function compactCandidatePool(
  jobs: readonly RecommendedJobSummary[],
): RecommendedJobSummary[] {
  return jobs.slice(0, MAX_POOL_SIZE).map((job, index) => {
    const value = RecommendedJobSummarySchema.parse(job) as RecommendedJobSummary;
    if (index < FULL_SUMMARY_COUNT) return value;
    return {
      jobId: value.jobId,
      brandName: value.brandName,
      jobName: value.jobName,
      storeName: value.storeName,
      storeAddress: value.storeAddress,
      cityName: value.cityName,
      regionName: value.regionName,
      laborForm: value.laborForm,
      partTimeJobType: value.partTimeJobType,
      jobCategoryName: value.jobCategoryName,
      studentTier: value.studentTier,
      resumeRequired: value.resumeRequired,
      ageRequirement: value.ageRequirement,
      educationRequirement: value.educationRequirement,
      healthCertificateRequirement: value.healthCertificateRequirement,
      salaryDesc: null,
    };
  });
}
