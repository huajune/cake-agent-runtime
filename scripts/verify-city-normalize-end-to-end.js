#!/usr/bin/env node
/* End-to-end 验证 normalizeCity 行为：
   - 模拟 invite-to-group.tool.ts 的过滤逻辑
   - 输入 Agent 实际传过的 city 字符串
   - 输出修复前/修复后是否会命中候选群
*/
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

// 与 src/biz/group-task/utils/city-normalize.util.ts 同款
function normalizeCity(input) {
  if (!input) return '';
  let s = String(input).trim();
  while (s.endsWith('市') || s.endsWith('省')) s = s.slice(0, -1).trim();
  return s;
}

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

  const seen = new Map();
  for (const r of all) seen.set(r.wxid, r);
  const dedup = Array.from(seen.values()).filter((r) => !r.deleted);

  const partTimeGroups = dedup
    .filter((r) => (r.labels || [])[0]?.name === '兼职群')
    .map((r) => ({
      groupName: r.topic,
      city: (r.labels || [])[1]?.name,
      industry: (r.labels || [])[2]?.name,
    }));

  // 模拟 Agent 历史真实调用过的 city/industry 入参
  const realCalls = [
    { caseId: '2k2km06k', city: '北京市', industry: '餐饮', expectHit: true, note: 'Fix 2.A 应该消化' },
    { caseId: 'cawp805w', city: '北京市', industry: '零售', expectHit: false, note: '北京零售群池为空' },
    { caseId: '2tmmb83q', city: '北京', industry: '餐饮', expectHit: true, note: '不带"市"应能直接命中' },
    { caseId: 'i41pab8n', city: '上海', industry: '餐饮', expectHit: true, note: '上海餐饮 4 个候选' },
    { caseId: '2tn5zktx', city: '上海', industry: '零售', expectHit: true, note: '上海零售 2 个候选' },
    { caseId: '其他', city: '上海市', industry: undefined, expectHit: true, note: '无 industry 也应命中' },
    { caseId: '其他', city: '深圳市', industry: '餐饮', expectHit: false, note: '深圳无兼职群' },
  ];

  for (const probe of realCalls) {
    // 修复前：strict equality
    const beforeFix = partTimeGroups.filter((g) => g.city === probe.city);
    // 修复后：normalizeCity
    const nTarget = normalizeCity(probe.city);
    const afterFix = partTimeGroups.filter((g) => normalizeCity(g.city) === nTarget);

    const matchActual = probe.industry
      ? afterFix.filter((g) => g.industry === probe.industry)
      : afterFix;

    const verdict = matchActual.length > 0 ? '✅命中' : '❌空';
    const expected = probe.expectHit ? '应命中' : '应为空';
    const status = (matchActual.length > 0) === probe.expectHit ? '√' : '✗ 与预期不符!';
    console.log(
      `[${probe.caseId}] city="${probe.city}" industry="${probe.industry || '-'}" → ` +
      `修复前 city精确=${beforeFix.length}, 修复后 normalize=${afterFix.length}, industry筛后=${matchActual.length} ` +
      `${verdict}（${expected}） ${status}  // ${probe.note}`,
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
