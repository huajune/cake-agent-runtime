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
  '独立客&上海零售兼职①群',
  '独立客&上海零售兼职②群',
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
    if (page > 50) break;
  }
  return all;
}

(async () => {
  const all = await fetchAll();
  console.log(`Total enterprise groups fetched: ${all.length}`);

  // Build manager → group memberships matrix
  const membershipMatrix = {}; // managerName → [groupNames]
  for (const name of Object.keys(MANAGERS)) membershipMatrix[name] = [];

  for (const group of all) {
    const name = group.name || group.topic;
    const members = group.memberList || [];
    for (const [mgrName, botId] of Object.entries(MANAGERS)) {
      const inGroup = members.some((m) => m.imContactId === botId);
      if (inGroup) membershipMatrix[mgrName].push(name);
    }
  }

  console.log('---');
  for (const [mgr, groups] of Object.entries(membershipMatrix)) {
    console.log(`[${mgr}] is in ${groups.length} enterprise groups`);
  }

  console.log('\n=== Target groups membership matrix ===');
  const header = ['group'.padEnd(35), ...Object.keys(MANAGERS).map((m) => m.padEnd(18))];
  console.log(header.join(' | '));
  console.log('-'.repeat(header.join(' | ').length));

  for (const targetName of TARGET_GROUPS) {
    const group = all.find((g) => (g.name || g.topic) === targetName);
    if (!group) {
      console.log(targetName.padEnd(35) + ' | NOT FOUND in enterprise list');
      continue;
    }
    const members = group.memberList || [];
    const row = [targetName.padEnd(35)];
    for (const [mgrName, botId] of Object.entries(MANAGERS)) {
      row.push((members.some((m) => m.imContactId === botId) ? '✅ in' : '❌ not in').padEnd(18));
    }
    console.log(row.join(' | '));
  }

  console.log('\n=== 上海零售③群 详情 ===');
  const tgt = all.find((g) => (g.name || g.topic) === '独立客&上海零售兼职③群');
  if (tgt) {
    console.log('owner:', tgt.owner);
    console.log('memberList:');
    for (const m of tgt.memberList || []) {
      const isManagerBot = Object.values(MANAGERS).includes(m.imContactId);
      console.log(
        `  - imContactId=${m.imContactId}, type=${m.type}, externalUserId=${m.externalUserId || '-'}, nickName=${m.nickName || '-'} ${isManagerBot ? '【我方bot】' : ''}`,
      );
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
