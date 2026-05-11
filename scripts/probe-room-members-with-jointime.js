#!/usr/bin/env node
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

const ENT = process.env.STRIDE_ENTERPRISE_API_BASE_URL;
const ENT_TOKEN = process.env.STRIDE_ENTERPRISE_TOKEN;

const MANAGERS = {
  gaoyaqi: '1688855974513959',
  ZhuDongSheng: '1688854363869800',
  LiHanTing: '1688854359801821',
  CongLingKaiShiDeXianShiShiJie: '1688855171908166',
};

const TARGET_GROUPS = [
  '独立客&上海零售兼职③群',
  '独立客&上海餐饮兼职⑦群',
  '独立客&北京餐饮兼职②群',
  '独立客&深圳餐饮兼职群',
  '独立客&大连餐饮兼职群',
];

async function getJSON(url) {
  const r = await fetch(url);
  return r.json().catch(() => ({}));
}

async function fetchAll() {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${ENT}/api/v2/groupChat/list?token=${ENT_TOKEN}&page=${page}&pageSize=200`;
    const resp = await getJSON(url);
    const rows = resp?.data?.list || resp?.data?.records || resp?.data || [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 200) break;
    page++;
    if (page > 80) break;
  }
  return all;
}

function fmtTs(ts) {
  if (!ts) return '-';
  const ms = String(ts).length === 10 ? ts * 1000 : ts;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

(async () => {
  const all = await fetchAll();
  console.log(`Total enterprise groups fetched: ${all.length}\n`);

  for (const groupName of TARGET_GROUPS) {
    const group = all.find((g) => (g.name || g.topic) === groupName);
    console.log(`=== ${groupName} ===`);
    if (!group) {
      console.log('  NOT FOUND');
      continue;
    }
    console.log(`  owner: ${group.owner}, createTime: ${fmtTs(group.createTime)}`);
    for (const [mgrName, botId] of Object.entries(MANAGERS)) {
      const member = (group.memberList || []).find((m) => m.imContactId === botId);
      if (member) {
        console.log(`  ✅ ${mgrName.padEnd(32)} joinTime=${fmtTs(member.joinTime)} joinScene=${member.joinScene}`);
      } else {
        console.log(`  ❌ ${mgrName.padEnd(32)} NOT IN GROUP`);
      }
    }
    console.log();
  }
})().catch((e) => { console.error(e); process.exit(1); });
