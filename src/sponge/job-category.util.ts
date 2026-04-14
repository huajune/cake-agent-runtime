export function splitJobCategorySegments(jobCategoryName: string | null | undefined): string[] {
  if (!jobCategoryName) return [];

  return jobCategoryName
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function getPrimaryJobIndustry(
  jobCategoryName: string | null | undefined,
): '餐饮' | '零售' | null {
  const primaryCategory = splitJobCategorySegments(jobCategoryName)[0];

  if (primaryCategory === '餐饮') return '餐饮';
  if (primaryCategory === '零售') return '零售';

  return null;
}
