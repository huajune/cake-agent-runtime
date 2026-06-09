/* eslint-disable */
// A/B 基准：同一请求体、同一时刻，对比老 URL(k8s/persistence) vs 新 URL(gateway/sponge) 的 job/list 延迟。
// 复刻 precheck 调用形态（单 jobId, pageSize=1, 全字段 options），交替打消除时段偏差。
// 用法：node scripts/bench-job-list-ab.js
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
const TOKEN = env.DULIDAY_API_TOKEN;
const OLD_URL = 'https://k8s.duliday.com/persistence/ai/api/job/list';
const NEW_URL = 'https://gateway.duliday.com/sponge/ai/api/job/list';
const PRECHECK_OPTIONS = { includeBasicInfo: true, includeHiringRequirement: true, includeInterviewProcess: true };

async function timedPost(url, body) {
  const t0 = process.hrtime.bigint();
  let status = 0, code = null, bytes = 0, count = 0;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Duliday-Token': TOKEN },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    bytes = Buffer.byteLength(text, 'utf8');
    try { const j = JSON.parse(text); code = j.code; count = j.data?.result?.length ?? 0; } catch {}
  } catch (e) { status = -1; code = e.message; }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status, code, bytes, count };
}
function stats(arr) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const pct = (p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  return { n: a.length, min: Math.round(a[0]), avg: Math.round(a.reduce((s, x) => s + x, 0) / a.length),
    p50: Math.round(pct(50)), p90: Math.round(pct(90)), p95: Math.round(pct(95)), max: Math.round(a[a.length - 1]) };
}
const body = (jobId) => ({ pageNum: 1, pageSize: 1, sort: 'desc', sortField: 'create_time', queryParam: { jobIdList: [jobId] }, options: PRECHECK_OPTIONS });

(async () => {
  // 拿一批真实 jobId（用新接口城市查询）
  const seed = await fetch(NEW_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Duliday-Token': TOKEN },
    body: JSON.stringify({ pageNum: 1, pageSize: 15, sort: 'desc', sortField: 'create_time', queryParam: { cityNameList: ['上海'] }, options: { includeBasicInfo: true } }),
  }).then((r) => r.json());
  const jobIds = (seed.data?.result ?? []).map((j) => j.basicInfo?.jobId).filter(Boolean).slice(0, 15);
  console.log('采样 jobId 数 =', jobIds.length);

  const oldLat = [], newLat = [];
  const ROUNDS = 3;
  for (let r = 0; r < ROUNDS; r++) {
    for (const jobId of jobIds) {
      // 交替顺序，奇偶轮调换先后，避免顺序偏置
      const order = (r % 2 === 0) ? ['OLD', 'NEW'] : ['NEW', 'OLD'];
      for (const which of order) {
        const url = which === 'OLD' ? OLD_URL : NEW_URL;
        const res = await timedPost(url, body(jobId));
        const ok = res.status === 200 && res.code === 0 && res.count === 1;
        (which === 'OLD' ? oldLat : newLat).push(ok ? res.ms : null);
        if (!ok) console.log(`  [${which}] jobId=${jobId} 非正常返回 status=${res.status} code=${res.code} count=${res.count} bytes=${res.bytes}`);
      }
    }
    console.log(`round ${r + 1}/${ROUNDS} done`);
  }

  console.log('\n========== A/B 汇总 (ms, 仅统计 code=0 成功返回) ==========');
  console.log('老接口 k8s/persistence :', JSON.stringify(stats(oldLat)));
  console.log('新接口 gateway/sponge  :', JSON.stringify(stats(newLat)));
})().catch((e) => { console.error('bench 失败:', e.message); process.exit(1); });
