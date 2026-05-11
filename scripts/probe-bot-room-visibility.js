#!/usr/bin/env node
/* 排查每个 manager 的 bot 视角：
   1) /bot/getGroupBots 列出企业内所有可见托管账号
   2) /groupChat/list 用企业 token 列出企业级群（看视角）
   3) 把每个 manager bot 与"上海零售③群"做对照
   全部 GET，无副作用。
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

const STRIDE = process.env.STRIDE_API_BASE_URL;
const ENT = process.env.STRIDE_ENTERPRISE_API_BASE_URL;
const ENT_TOKEN = process.env.STRIDE_ENTERPRISE_TOKEN;

// Known manager → bot_im_id (from recruitment_cases)
const MANAGERS = {
  gaoyaqi: '1688855974513959',
  ZhuDongSheng: '1688854363869800',
  LiHanTing: '1688854359801821',
  CongLingKaiShiDeXianShiShiJie: '1688855171908166',
};

const TARGET_ROOM_WXID = 'R:10763217499401418'; // 独立客&上海零售兼职③群
const TARGET_OWNER_BOT_WXID = '1688855974513959'; // gaoyaqi

async function getJSON(url) {
  const r = await fetch(url);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { _raw: text.slice(0, 500), _status: r.status };
  }
}

(async () => {
  // ── 1) /bot/getGroupBots 看企业内托管账号
  const botsUrl = `${ENT}/api/v1/bot/getGroupBots?token=${ENT_TOKEN}`;
  console.log('[1] GET /bot/getGroupBots');
  const botsResp = await getJSON(botsUrl);
  console.log('  status code:', botsResp?.code, 'msg:', botsResp?.msg);

  // try to enumerate groups → bots
  const groups = botsResp?.data?.groupList || botsResp?.data?.groups || botsResp?.data || [];
  if (Array.isArray(groups)) {
    console.log(`  groups: ${groups.length}`);
    const byBotWxid = new Map();
    for (const g of groups) {
      const bots = g.bots || g.botList || [];
      for (const b of bots) {
        const wxid = b.wxid || b.imBotId || b.id;
        if (!wxid) continue;
        if (!byBotWxid.has(wxid)) byBotWxid.set(wxid, []);
        byBotWxid.get(wxid).push({
          groupName: g.groupName || g.name,
          groupId: g.groupId || g.id,
          weixin: b.wecomUserId || b.weixin,
          name: b.name || b.nickName,
        });
      }
    }
    console.log(`  unique bots seen: ${byBotWxid.size}`);
    console.log('---');
    for (const [name, bid] of Object.entries(MANAGERS)) {
      const presence = byBotWxid.get(bid);
      if (!presence) {
        console.log(`  [${name}] bot_im_id=${bid} → ❌ 未出现在 /bot/getGroupBots`);
      } else {
        console.log(
          `  [${name}] bot_im_id=${bid} → groups: ${presence.map((p) => p.groupName).join(', ')}`,
        );
        console.log(`    weixin/wecomUserId: ${presence[0].weixin}`);
      }
    }
  } else {
    console.log('  unexpected response shape:', JSON.stringify(botsResp).slice(0, 400));
  }

  console.log('\n---');

  // ── 2) /groupChat/list (enterprise-v2) 看企业级群视角
  const gcListUrl = `${ENT}/api/v2/groupChat/list?token=${ENT_TOKEN}&page=1&pageSize=200`;
  console.log('[2] GET /groupChat/list (enterprise v2)');
  const gcResp = await getJSON(gcListUrl);
  console.log('  status code:', gcResp?.code, 'msg:', gcResp?.msg);
  const gcList = gcResp?.data?.list || gcResp?.data?.records || gcResp?.data || [];
  if (Array.isArray(gcList)) {
    console.log(`  rooms in enterprise view: ${gcList.length}`);
    const target = gcList.find((r) => r.wxid === TARGET_ROOM_WXID || r.imRoomId === TARGET_ROOM_WXID || r.roomWxid === TARGET_ROOM_WXID);
    if (target) {
      console.log('  ✅ found target room R:10763217499401418 in enterprise view:');
      console.log('    ', JSON.stringify(target).slice(0, 500));
    } else {
      console.log('  ❌ target room NOT in enterprise list view');
      console.log('  sample first record keys:', Object.keys(gcList[0] || {}).join(','));
      if (gcList[0]) console.log('  sample:', JSON.stringify(gcList[0]).slice(0, 300));
    }
  } else {
    console.log('  shape:', JSON.stringify(gcResp).slice(0, 400));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
