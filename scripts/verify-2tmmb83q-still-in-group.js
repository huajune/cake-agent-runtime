#!/usr/bin/env node
/* 重新拉取企业级 memberList，确认 2tmmb83q 候选人当前仍在"独立客&北京餐饮兼职②群"。 */
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

const TARGET_GROUP = '独立客&北京餐饮兼职②群';
const TARGET_NICK = '就叫这个名字';
const TARGET_IMCONTACTID = '7881299683986519';

(async () => {
  let page = 1;
  let target = null;
  while (!target && page <= 80) {
    const url = `${ENT}/api/v2/groupChat/list?token=${ENT_TOKEN}&page=${page}&pageSize=200`;
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    const rows = j?.data?.list || j?.data?.records || j?.data || [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    target = rows.find((x) => (x.name || x.topic) === TARGET_GROUP);
    if (rows.length < 200) break;
    page++;
  }

  if (!target) {
    console.log('❌ 没找到目标群');
    process.exit(0);
  }
  console.log(`目标群: ${target.name}`);
  console.log(`memberList 长度: ${(target.memberList || []).length}`);

  const byImContactId = (target.memberList || []).find((m) => m.imContactId === TARGET_IMCONTACTID);
  const byNick = (target.memberList || []).filter((m) => (m.nickName || '').includes(TARGET_NICK));

  console.log(`按 imContactId=${TARGET_IMCONTACTID} 查找:`, byImContactId ? '✅ 还在' : '❌ 不在了');
  if (byImContactId) {
    const joinDate = new Date(byImContactId.joinTime * 1000).toISOString();
    console.log(`  joinTime=${byImContactId.joinTime} (${joinDate})`);
  }
  console.log(`按昵称"${TARGET_NICK}"模糊查找: ${byNick.length} 个`);
  for (const m of byNick) {
    const joinDate = new Date(m.joinTime * 1000).toISOString();
    console.log(`  - imContactId=${m.imContactId} nickName=${m.nickName} joinTime=${joinDate}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
