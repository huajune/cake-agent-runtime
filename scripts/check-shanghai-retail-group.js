#!/usr/bin/env node
/* 排查"独立客&上海零售兼职③群" room not found 根因：
   1) 是否在小组级 simpleList 里能查到？
   2) 同名群是否存在多个 wxid？
   3) 每个 wxid 对应的 memberCount / deleted / botInfo？
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
const RAW_TOKENS = process.env.GROUP_TASK_TOKENS || '';
const TARGET = '独立客&上海零售兼职③群';

const tokenMap = {};
for (const pair of RAW_TOKENS.split(',').filter(Boolean)) {
  const idx = pair.indexOf(':');
  if (idx < 0) continue;
  tokenMap[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
}

async function fetchAll(name, token) {
  const all = [];
  let current = 0;
  const pageSize = 100;
  while (true) {
    const url = `${BASE}/stream-api/room/simpleList?token=${token}&current=${current}&pageSize=${pageSize}`;
    const r = await fetch(url);
    const j = await r.json();
    const data = j?.data?.data || j?.data || [];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const room of data) {
      all.push({
        team: name,
        wxid: room.wxid,
        topic: room.topic,
        chatId: room.chatId,
        botWxid: room.botInfo?.wxid,
        botNick: room.botInfo?.nickName,
        labels: (room.labels || []).map((l) => l.name).join('|'),
        memberCount: room.memberCount,
        deleted: room.deleted,
      });
    }
    const total = j?.data?.page?.total || j?.page?.total || 0;
    current++;
    if (current * pageSize >= total) break;
  }
  return all;
}

(async () => {
  console.log('Teams:', Object.keys(tokenMap).join(', '));
  const allRooms = [];
  for (const [name, token] of Object.entries(tokenMap)) {
    try {
      const rooms = await fetchAll(name, token);
      console.log(`team [${name}]: ${rooms.length} rooms`);
      allRooms.push(...rooms);
    } catch (e) {
      console.error(`team [${name}] failed:`, e.message);
    }
  }

  // Find target by exact and partial match
  const exact = allRooms.filter((r) => r.topic === TARGET);
  const partial = allRooms.filter((r) => r.topic && r.topic.includes('上海零售兼职③') && r.topic !== TARGET);
  console.log('---');
  console.log(`exact match "${TARGET}": ${exact.length}`);
  for (const r of exact) {
    console.log(JSON.stringify(r));
  }
  console.log(`partial match containing "上海零售兼职③": ${partial.length}`);
  for (const r of partial) {
    console.log(JSON.stringify(r));
  }

  // Also list all 上海/零售 兼职群 to see siblings
  const shRetail = allRooms.filter((r) => r.labels?.includes('兼职群') && r.labels?.includes('上海') && r.labels?.includes('零售'));
  console.log('---');
  console.log(`all [兼职群+上海+零售] rooms: ${shRetail.length}`);
  for (const r of shRetail) {
    console.log(JSON.stringify(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
