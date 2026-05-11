#!/usr/bin/env node
/* 排查：
   1) 北京零售/餐饮兼职群在 simpleList（琪琪小组视图）vs /groupChat/list（企业视图）的差异
      —— 解释 cawp805w / 2k2km06k 的 no_group_in_city
   2) 候选人 2tmmb83q 的 wxid 是否真在"独立客&北京餐饮兼职②群"
      —— 验证 already_in_group 是真还是误判
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
const ENT = process.env.STRIDE_ENTERPRISE_API_BASE_URL;
const ENT_TOKEN = process.env.STRIDE_ENTERPRISE_TOKEN;
const RAW = process.env.GROUP_TASK_TOKENS || '';
const TEAM_TOKENS = {};
for (const pair of RAW.split(',').filter(Boolean)) {
  const idx = pair.indexOf(':');
  if (idx >= 0) TEAM_TOKENS[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
}

const TARGET_2TMMB83Q_CHAT_ID = '69fc5b01536c965402926e76';

async function getJSON(url) {
  const r = await fetch(url);
  return r.json().catch(() => ({}));
}

async function fetchSimpleListAll(token) {
  const all = [];
  let current = 0;
  while (true) {
    const url = `${BASE}/stream-api/room/simpleList?token=${token}&current=${current}&pageSize=100`;
    const resp = await getJSON(url);
    const rooms = resp?.data?.data || resp?.data || [];
    if (!Array.isArray(rooms) || rooms.length === 0) break;
    all.push(...rooms);
    const total = resp?.data?.page?.total || 0;
    current++;
    if (current * 100 >= total) break;
  }
  return all;
}

async function fetchEnterpriseAll() {
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

(async () => {
  console.log('=== 拉数据中（simpleList × 团队token + enterprise /groupChat/list）===\n');

  // 1) simpleList（小组视图）
  const teamRooms = {};
  for (const [team, token] of Object.entries(TEAM_TOKENS)) {
    teamRooms[team] = await fetchSimpleListAll(token);
    console.log(`team [${team}] simpleList: ${teamRooms[team].length} rooms`);
  }

  // 2) enterprise（企业视图）
  const entRooms = await fetchEnterpriseAll();
  console.log(`enterprise /groupChat/list: ${entRooms.length} rooms\n`);

  // ===== Task A: 北京兼职群（零售+餐饮）= 在 simpleList 是否能被 group resolver 看到 =====
  const beijingCandidates = entRooms.filter((r) => {
    const name = r.name || r.topic || '';
    return name.includes('北京') && (name.includes('兼职') || name.includes('零售') || name.includes('餐饮'));
  });

  console.log('=== 北京兼职相关群（企业视图） ===');
  console.log(`共 ${beijingCandidates.length} 个`);
  for (const r of beijingCandidates) {
    const name = r.name || r.topic || '';
    const wxid = r.wxid || r.imRoomId || r.roomWxid || '-';
    // 同名在 simpleList 里是否能找到（按 wxid 精确匹配）
    let inSimpleList = false;
    let labels = null;
    for (const [team, rooms] of Object.entries(teamRooms)) {
      const hit = rooms.find((x) => x.wxid === wxid);
      if (hit) {
        inSimpleList = true;
        labels = (hit.labels || []).map((l) => l.name);
        break;
      }
    }
    const labelStatus = inSimpleList
      ? labels && labels.length >= 2
        ? `labels=[${labels.join('|')}]`
        : `labels=[${labels?.join('|') || '空'}] ❌ 不足以被 resolver 识别`
      : '❌ 不在任何小组 simpleList 中';
    console.log(`  - ${name}  ${labelStatus}`);
  }

  // ===== Task B: 2tmmb83q 候选人 wxid 是否真在"北京餐饮兼职②群" =====
  console.log('\n=== Task B: 2tmmb83q 候选人是否真在北京餐饮兼职②群 ===');

  // 先从 chat_messages 拿候选人 contactWxid（即 userId）
  // 这里没法直接查 DB，但我们已经知道 chatId；候选人 contactWxid 与他在该 bot 视角下的 userId 同维度
  // 直接查目标群 memberList，看里面有没有 nickname=该候选人 或 imContactId=对应 wxid
  const targetGroup = entRooms.find((r) => (r.name || r.topic) === '独立客&北京餐饮兼职②群');
  if (!targetGroup) {
    console.log('❌ 没找到目标群');
  } else {
    console.log(`目标群: ${targetGroup.name}`);
    console.log(`owner: ${targetGroup.owner}`);
    console.log(`memberCount(企业视图): ${(targetGroup.memberList || []).length}`);
    console.log('memberList (type=1 = external contacts):');
    const externals = (targetGroup.memberList || []).filter((m) => m.type === 1);
    console.log(`  external count: ${externals.length}`);
    // 候选人在 chat_messages 里 candidate_name = "就叫这个名字"
    const matchByNick = externals.filter((m) => (m.nickName || '').includes('就叫这个名字'));
    console.log(`  按昵称"就叫这个名字"匹配: ${matchByNick.length} 个`);
    for (const m of matchByNick) {
      console.log(`    - imContactId=${m.imContactId} nickName=${m.nickName} joinTime=${m.joinTime}`);
    }
    if (matchByNick.length === 0) {
      console.log('  → 候选人确实不在群里，但 invite API 返回 already_in_group = ⚠️ 上游接口误判');
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
