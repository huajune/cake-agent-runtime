/* eslint-disable */
// 临时基准：对海绵新网关 job/list 接口实测延迟，复刻 precheck 的调用形态。
// 用法：node scripts/bench-job-list-latency.js
const fs = require('fs');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...loadEnv('.env.local'), ...process.env };

const BASE = (env.SPONGE_API_BASE_URL || 'https://gateway.duliday.com/sponge').replace(/\/+$/, '');
const TOKEN = env.DULIDAY_API_TOKEN;
const JOB_LIST_API = `${BASE}/ai/api/job/list`;
if (!TOKEN) {
  console.error('缺少 DULIDAY_API_TOKEN');
  process.exit(1);
}

// precheck 用的全字段 options
const PRECHECK_OPTIONS = {
  includeBasicInfo: true,
  includeHiringRequirement: true,
  includeInterviewProcess: true,
};

async function timedPost(body) {
  const t0 = process.hrtime.bigint();
  let status = 0;
  let code = null;
  let bytes = 0;
  let resultCount = 0;
  try {
    const res = await fetch(JOB_LIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Duliday-Token': TOKEN },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    bytes = Buffer.byteLength(text, 'utf8');
    try {
      const json = JSON.parse(text);
      code = json.code;
      resultCount = json.data?.result?.length ?? 0;
    } catch {}
  } catch (e) {
    status = -1;
    code = e.message;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, status, code, bytes, resultCount };
}

function stats(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const pct = (p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  const sum = a.reduce((s, x) => s + x, 0);
  return {
    n: a.length,
    min: Math.round(a[0]),
    avg: Math.round(sum / a.length),
    p50: Math.round(pct(50)),
    p90: Math.round(pct(90)),
    p95: Math.round(pct(95)),
    max: Math.round(a[a.length - 1]),
  };
}

(async () => {
  console.log('JOB_LIST_API =', JOB_LIST_API);

  // 1) 先用城市查询拉一页，拿到真实 jobId 列表
  const seed = await timedPost({
    pageNum: 1,
    pageSize: 30,
    sort: 'desc',
    sortField: 'create_time',
    queryParam: { cityNameList: ['上海'] },
    options: { includeBasicInfo: true },
  });
  console.log(`\n[城市列表查询 pageSize=30] ${Math.round(seed.ms)}ms status=${seed.status} code=${seed.code} count=${seed.resultCount} bytes=${seed.bytes}`);

  // 重新拉一次拿 jobId（上面只统计了 count）
  const seedRes = await fetch(JOB_LIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Duliday-Token': TOKEN },
    body: JSON.stringify({
      pageNum: 1, pageSize: 30, sort: 'desc', sortField: 'create_time',
      queryParam: { cityNameList: ['上海'] }, options: { includeBasicInfo: true },
    }),
  }).then((r) => r.json());
  const jobIds = (seedRes.data?.result ?? []).map((j) => j.basicInfo?.jobId ?? j.jobId).filter(Boolean).slice(0, 12);
  console.log('采样 jobId 数 =', jobIds.length, jobIds.slice(0, 5), '...');

  if (jobIds.length === 0) {
    console.error('没拿到 jobId，终止');
    process.exit(1);
  }

  // 2) precheck 形态：单 jobId + 全字段 options，逐个串行打，每个打 2 轮
  console.log('\n=== A. precheck 形态（单 jobId, pageSize=1, 全字段 options）===');
  const precheckLat = [];
  for (let round = 0; round < 2; round++) {
    for (const jobId of jobIds) {
      const r = await timedPost({
        pageNum: 1,
        pageSize: 1,
        sort: 'desc',
        sortField: 'create_time',
        queryParam: { jobIdList: [jobId] },
        options: PRECHECK_OPTIONS,
      });
      precheckLat.push(r.ms);
      console.log(`  jobId=${jobId} r${round} -> ${Math.round(r.ms)}ms status=${r.status} code=${r.code} count=${r.resultCount} bytes=${r.bytes}`);
    }
  }

  // 3) booking 形态：单 jobId，少一个 includeHiringRequirement
  console.log('\n=== B. booking 形态（单 jobId, 不含 hiringRequirement）===');
  const bookingLat = [];
  for (const jobId of jobIds) {
    const r = await timedPost({
      pageNum: 1,
      pageSize: 1,
      sort: 'desc',
      sortField: 'create_time',
      queryParam: { jobIdList: [jobId] },
      options: { includeBasicInfo: true, includeInterviewProcess: true },
    });
    bookingLat.push(r.ms);
    console.log(`  jobId=${jobId} -> ${Math.round(r.ms)}ms status=${r.status} code=${r.code} bytes=${r.bytes}`);
  }

  console.log('\n========== 汇总 (ms) ==========');
  console.log('A precheck形态:', JSON.stringify(stats(precheckLat)));
  console.log('B booking形态 :', JSON.stringify(stats(bookingLat)));
})().catch((e) => {
  console.error('bench 失败:', e.message);
  process.exit(1);
});
