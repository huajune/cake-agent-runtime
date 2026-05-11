#!/usr/bin/env node
/* 干净对账：所有北京/上海/深圳等城市的兼职群，在 group_resolver 视角下能否被命中。
   重点验证：Agent 传 city="北京市" 是否会因为 labels 里是 city="北京" 而 miss。 */
const fs = require('fs');
const path = require('path');

(() => {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] != null) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
})();

const BASE = process.env.STRIDE_API_BASE_URL;
const RAW = process.env.GROUP_TASK_TOKENS || '';
const idx = RAW.indexOf(':');
const TOKEN = idx >= 0 ? RAW.slice(idx + 1).split(',')[0].trim() : '';

(async () => {
  const all = [];
  let current = 0;
  while (true) {
    const url = `${BASE}/stream-api/room/simpleList?token=${TOKEN}&current=${current}&pageSize=100`;
    const r = await fetch(url);
    const j = await r.json();
    const rooms = j?.data?.data || j?.data || [];
    if (!Array.isArray(rooms) || rooms.length === 0) break;
    all.push(...rooms);
    const total = j?.data?.page?.total || 0;
    current++;
    if (current * 100 >= total) break;
  }

  // 按 wxid 去重
  const seen = new Map();
  for (const r of all) seen.set(r.wxid, r);
  const dedup = Array.from(seen.values()).filter((r) => !r.deleted);

  // 只看兼职群
  const partTimeGroups = dedup.filter((r) => {
    const labels = (r.labels || []).map((l) => l.name);
    return labels[0] === '兼职群';
  });

  console.log(`兼职群总数（小组视图，琪琪 token，去重后）：${partTimeGroups.length}`);
  console.log('city × industry 矩阵：');
  const matrix = {};
  for (const r of partTimeGroups) {
    const labels = (r.labels || []).map((l) => l.name);
    const city = labels[1] || '(空)';
    const industry = labels[2] || '(无行业)';
    matrix[city] = matrix[city] || {};
    matrix[city][industry] = (matrix[city][industry] || 0) + 1;
  }
  for (const city of Object.keys(matrix).sort()) {
    const parts = Object.entries(matrix[city])
      .map(([ind, n]) => `${ind}=${n}`)
      .join(', ');
    console.log(`  ${city}: ${parts}`);
  }

  console.log('\n--- 字符串敏感测试 ---');
  for (const probe of ['北京', '北京市', '上海', '上海市', '深圳', '深圳市']) {
    const count = partTimeGroups.filter((r) => (r.labels || []).some((l) => l.name === probe)).length;
    console.log(`  group.city === "${probe}"  →  ${count} 个匹配`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
