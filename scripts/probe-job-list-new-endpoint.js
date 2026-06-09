/* eslint-disable */
// 临时探针：从海绵网关新接口拉取真实岗位/品牌数据，分析返回结构。
// 用法：node -r dotenv/config scripts/probe-job-list-new-endpoint.js dotenv_config_path=.env.local
const fs = require('fs');

// 轻量读取 .env.local（无 dotenv 依赖）
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
const BRAND_LIST_API = `${BASE}/ai/api/brand/list`;

if (!TOKEN) {
  console.error('缺少 DULIDAY_API_TOKEN');
  process.exit(1);
}

const PAGE_SIZE = 50;
const TARGET = 500;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Duliday-Token': TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应 (${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

// 收集所有出现过的字段路径（含类型），用于"全量结构"分析
function collectPaths(obj, prefix, acc) {
  if (obj === null) {
    acc.set(prefix, (acc.get(prefix) || new Set()).add('null'));
    return;
  }
  if (Array.isArray(obj)) {
    acc.set(prefix + '[]', (acc.get(prefix + '[]') || new Set()).add('array'));
    for (const el of obj.slice(0, 5)) collectPaths(el, prefix + '[]', acc);
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      collectPaths(v, p, acc);
    }
    return;
  }
  acc.set(prefix, (acc.get(prefix) || new Set()).add(typeof obj));
}

(async () => {
  console.log('BASE =', BASE);
  console.log('JOB_LIST_API =', JOB_LIST_API);

  // 1) 品牌列表
  const brandResp = await postJson(BRAND_LIST_API, { pageNum: 1, pageSize: 1000 });
  console.log('\n=== 品牌列表 code/total ===', brandResp.json?.code, '/', brandResp.json?.data?.total);
  console.log('品牌示例[0]:', JSON.stringify(brandResp.json?.data?.result?.[0], null, 2));

  // 2) 岗位列表 全量字段开关
  const options = {
    includeBasicInfo: true,
    includeJobSalary: true,
    includeWelfare: true,
    includeHiringRequirement: true,
    includeWorkTime: true,
    includeInterviewProcess: true,
  };

  // 接口要求至少一个筛选条件，按主要城市轮询累计到 TARGET。
  // onlySignableJobs:false 放开"仅可报名"约束以拿到更大样本做结构覆盖测试。
  const CITIES = [
    '上海', '北京', '广州', '深圳', '杭州', '成都', '武汉', '南京', '苏州', '西安',
    '重庆', '天津', '郑州', '长沙', '青岛', '宁波', '合肥', '福州', '无锡', '昆明',
    '佛山', '东莞', '珠海', '中山', '惠州', '常州', '南通', '徐州', '温州', '绍兴',
    '嘉兴', '金华', '泉州', '厦门', '济南', '烟台', '潍坊', '石家庄', '太原', '沈阳',
    '大连', '哈尔滨', '长春', '南昌', '南宁', '贵阳', '兰州', '海口', '扬州', '镇江',
  ];
  const jobs = [];
  const seenJobIds = new Set();
  let firstRaw = null;
  const totalsByCity = {};
  outer: for (const city of CITIES) {
    for (let pageNum = 1; ; pageNum++) {
      const { status, json } = await postJson(JOB_LIST_API, {
        pageNum,
        pageSize: PAGE_SIZE,
        sort: 'desc',
        sortField: 'create_time',
        queryParam: { cityNameList: [city], onlySignableJobs: false },
        options,
      });
      if (json.code !== 0) {
        console.error(`[${city}] code=${json.code} message=${json.message} (page ${pageNum}, status ${status})`);
        break;
      }
      if (pageNum === 1) totalsByCity[city] = json.data?.total ?? 0;
      const batch = json.data?.result ?? [];
      if (!firstRaw && batch.length) firstRaw = batch[0];
      if (batch.length === 0) break;
      for (const j of batch) {
        const id = j?.basicInfo?.jobId;
        if (typeof id === 'number' && seenJobIds.has(id)) continue;
        if (typeof id === 'number') seenJobIds.add(id);
        jobs.push(j);
      }
      if (jobs.length >= TARGET) break outer;
      if (pageNum * PAGE_SIZE >= (totalsByCity[city] ?? 0)) break;
    }
  }

  console.log(`\n城市轮询去重后 = ${jobs.length}`);

  // 城市样本不足 TARGET 时，用品牌维度补抓（覆盖不在城市清单里的岗位），jobId 去重。
  if (jobs.length < TARGET) {
    const brandIds = (brandResp.json?.data?.result ?? [])
      .map((b) => b?.id)
      .filter((id) => typeof id === 'number');
    brandLoop: for (const brandId of brandIds) {
      for (let pageNum = 1; ; pageNum++) {
        const { json } = await postJson(JOB_LIST_API, {
          pageNum,
          pageSize: PAGE_SIZE,
          sort: 'desc',
          sortField: 'create_time',
          queryParam: { brandIdList: [brandId], onlySignableJobs: false },
          options,
        });
        if (json.code !== 0) break;
        const batch = json.data?.result ?? [];
        if (batch.length === 0) break;
        for (const j of batch) {
          const id = j?.basicInfo?.jobId;
          if (typeof id === 'number' && seenJobIds.has(id)) continue;
          if (typeof id === 'number') seenJobIds.add(id);
          jobs.push(j);
        }
        if (jobs.length >= TARGET) break brandLoop;
        if (pageNum * PAGE_SIZE >= (json.data?.total ?? 0)) break;
      }
    }
  }

  console.log(`\n=== 岗位列表 ===`);
  const nonZero = Object.fromEntries(Object.entries(totalsByCity).filter(([, v]) => v > 0));
  console.log('各城市 total(非0) =', JSON.stringify(nonZero));
  console.log('去重后实际拉取 =', jobs.length);
  const total = jobs.length;

  // 字段路径全量收集
  const paths = new Map();
  for (const j of jobs) collectPaths(j, '', paths);
  const sorted = [...paths.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = sorted.map(([p, types]) => `${p}\t${[...types].join('|')}`);

  fs.writeFileSync(
    'scripts/probe-output-paths.txt',
    `total=${total} fetched=${jobs.length}\n\n` + lines.join('\n'),
  );
  fs.writeFileSync('scripts/probe-output-sample.json', JSON.stringify(firstRaw, null, 2));
  fs.writeFileSync('scripts/probe-output-jobs.json', JSON.stringify(jobs));
  console.log('字段路径数 =', sorted.length);
  console.log('已写出 scripts/probe-output-paths.txt / probe-output-sample.json / probe-output-jobs.json');
})().catch((e) => {
  console.error('探针失败:', e.message);
  process.exit(1);
});
