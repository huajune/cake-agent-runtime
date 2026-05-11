#!/usr/bin/env node
/* 确认 simpleList 返回里 botInfo 的实际字段；
   尤其 botInfo.weixin 是否可作为 addMemberEnterprise 的 botUserId */
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
  const url = `${BASE}/stream-api/room/simpleList?token=${TOKEN}&current=0&pageSize=5`;
  const r = await fetch(url);
  const j = await r.json();
  const rooms = j?.data?.data || j?.data || [];
  console.log(`Total rooms in this page: ${rooms.length}`);
  for (const room of rooms.slice(0, 3)) {
    console.log('---');
    console.log('topic:', room.topic);
    console.log('botInfo:', JSON.stringify(room.botInfo, null, 2));
    console.log('all top-level keys:', Object.keys(room).join(','));
  }
})().catch((e) => { console.error(e); process.exit(1); });
