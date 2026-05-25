/**
 * 预览 duliday_job_list 工具返回给 LLM 的完整 markdown。
 * 用法：
 *   pnpm ts-node -r tsconfig-paths/register -P scripts/tsconfig.json scripts/preview-tool-output.ts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });

import { formatJobsToMarkdown } from '@tools/duliday/job-list/render.util';
import {
  buildBrandNearestStoreSummary,
} from '@tools/duliday/job-list/brand-stores.util';
import { haversineDistance } from '@tools/duliday/job-list/search.util';

const TOKEN = process.env.DULIDAY_API_TOKEN ?? '';
const JOB_LIST_API = 'https://k8s.duliday.com/persistence/ai/api/job/list';

// ==================== 查询参数（按需改）====================
const QUERY = {
  cityNameList: ['上海'],
  regionNameList: [] as string[],
  jobCategoryList: [] as string[],
  pageSize: 5,
};

// 候选人坐标（陆家嘴附近）
const CANDIDATE_LAT = 31.2397;
const CANDIDATE_LNG = 121.4997;
// ===========================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJobs(): Promise<{ jobs: any[]; total: number }> {
  const body = {
    pageNum: 1,
    pageSize: QUERY.pageSize,
    sort: 'desc',
    sortField: 'create_time',
    queryParam: {
      cityNameList: QUERY.cityNameList,
      regionNameList: QUERY.regionNameList,
      jobCategoryList: QUERY.jobCategoryList,
    },
  };

  const res = await fetch(JOB_LIST_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Duliday-Token': TOKEN,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`API 响应 ${res.status}: ${await res.text()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = await res.json() as any;
  if (json?.code !== 0) throw new Error(`API 返回错误: ${json?.message ?? json?.code}`);
  const data = json?.data ?? {};
  const jobs = data?.result ?? [];
  const total = data?.total ?? jobs.length;
  console.log(`\n📦 API 返回 ${jobs.length} 条 / 共 ${total} 条\n`);
  return { jobs, total };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachDistance(jobs: any[]): any[] {
  return jobs.map((job) => {
    const store = job?.basicInfo?.storeInfo;
    if (store?.longitude != null && store?.latitude != null) {
      const dist = haversineDistance(
        CANDIDATE_LAT,
        CANDIDATE_LNG,
        Number(store.latitude),
        Number(store.longitude),
      );
      return { ...job, _distanceKm: Math.round(dist * 10) / 10 };
    }
    return job;
  });
}

async function main() {
  if (!TOKEN) {
    console.error('❌ 缺少 DULIDAY_API_TOKEN，检查 .env.local');
    process.exit(1);
  }

  const { jobs: rawJobs, total } = await fetchJobs();
  if (rawJobs.length === 0) {
    console.log('⚠️  查询结果为空，换个条件试试');
    return;
  }

  const jobs = attachDistance(rawJobs);
  const brandGroups = buildBrandNearestStoreSummary(jobs);

  const flags = {
    includeBasicInfo: true,
    includeJobSalary: true,
    includeWelfare: true,
    includeHiringRequirement: true,
    includeWorkTime: true,
    includeInterviewProcess: false,
  };

  const fullOutput = formatJobsToMarkdown(jobs, total, 1, QUERY.pageSize, flags, brandGroups);

  console.log('═'.repeat(80));
  console.log('  完整工具输出（LLM 看到的 markdown）');
  console.log('═'.repeat(80));
  console.log(fullOutput);
  console.log('═'.repeat(80));
  console.log(`\n✅ 共 ${jobs.length} 条岗位，总字符数: ${fullOutput.length}`);
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
