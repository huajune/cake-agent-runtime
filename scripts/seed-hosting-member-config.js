#!/usr/bin/env node

/**
 * 把分散的「飞书接收人（硬编码）」+「海绵 token（sponge_token_config）」导出成统一的
 * system_config.hosting_member_config（按 botImId/wxid 索引），供新解析链 / 未来 web 配置使用。
 *
 * 数据来源：
 *   - Stride getGroupBots：权威的 bot wxid 列表（核对哪些 botImId 仍在册）
 *   - 本脚本内联的 FEISHU 接收人表（拷贝自 src/infra/feishu/constants/receivers.ts）→ feishuOpenId
 *   - system_config.sponge_token_config（若有）→ dulidayToken（tokenEnv 会从环境变量解析成明文）
 *
 * 安全：默认 dry-run（只打印、不写库）。只有显式 --apply 才 upsert system_config。
 * 用法：
 *   node scripts/seed-hosting-member-config.js --env .env.local            # 预览
 *   node scripts/seed-hosting-member-config.js --env .env.local --apply    # 写入
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const HOSTING_MEMBER_CONFIG_KEY = 'hosting_member_config';
const SPONGE_TOKEN_CONFIG_KEY = 'sponge_token_config';
const DEFAULT_STRIDE_BASE = 'https://stride-bg.dpclouds.com/hub-api';

// 拷贝自 src/infra/feishu/constants/receivers.ts（一次性种子，故内联）。botImId(wxid) → 飞书接收人。
const BOT_TO_RECEIVER = {
  1688855974513959: { openId: 'ou_54b8b053840d689ae42d3ab6b61800d8', name: '高雅琪' },
  1688854747775509: { openId: 'ou_72e8d17db5dab36e4feeddfccaa6568d', name: '艾酱' },
  1688855171908166: { openId: 'ou_e6868065cb0baa3c0304441a6a8c16e7', name: '李宇航' },
  1688854363869800: { openId: 'ou_9834f6ccffb3abdbeeabbc28581af6df', name: '祝东升' },
  1688857592548257: { openId: 'ou_9834f6ccffb3abdbeeabbc28581af6df', name: '祝东升' },
  1688854359801821: { openId: 'ou_954fb7341fd7fdd320de2d419d26df19', name: '南瓜' },
  1688854263771949: { openId: 'ou_12cf003c378f89299f8ccf32252c22c0', name: '盼盼' },
  1688855753660960: { openId: 'ou_6d3f217a88b5033ff256c64492e52ae7', name: '小阳' },
};

function parseArgs(argv) {
  const args = { env: '.env.local', apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env' && argv[i + 1]) ((args.env = argv[i + 1]), (i += 1));
    else if (argv[i] === '--apply') args.apply = true;
  }
  return args;
}

function loadEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`env 文件不存在: ${absolute}`);
  for (const line of fs.readFileSync(absolute, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function requireEnv(name, fallbackName) {
  const v = process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);
  if (!v) throw new Error(`缺少环境变量 ${name}${fallbackName ? ` 或 ${fallbackName}` : ''}`);
  return v;
}

// 解析 sponge token 值（string | {token} | {tokenEnv}）→ 明文。
function resolveTokenValue(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (v.token && v.token.trim()) return v.token.trim();
  if (v.tokenEnv && process.env[v.tokenEnv]) return process.env[v.tokenEnv].trim();
  return null;
}

// 从 sponge_token_config 解析「按账号/组」的 token（不含全局 default / DULIDAY_API_TOKEN 兜底）。
// 只把真正按账号配置过的 token 写进 DB；没有就留空，运行时仍走既有 sponge_token_config / env 兜底。
function buildTokenResolver(config) {
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  const byField = (field, value) => {
    if (!value) return null;
    const acc = accounts.find((a) => a && a.enabled !== false && (a[field] ?? '').trim() === value);
    return resolveTokenValue(acc);
  };
  return ({ botImId, botUserId, groupId }) =>
    byField('botImId', botImId) ??
    resolveTokenValue(config?.byBotImId?.[botImId]) ??
    byField('botUserId', botUserId) ??
    resolveTokenValue(config?.byBotUserId?.[botUserId]) ??
    byField('groupId', groupId) ??
    resolveTokenValue(config?.byGroupId?.[groupId]) ??
    null;
}

// 脱敏 config 中各 member 的 dulidayToken，只保留尾 4 位用于核对；其余 → ***。
function redactTokens(config) {
  const members = {};
  for (const [botImId, entry] of Object.entries(config?.members ?? {})) {
    const masked = { ...entry };
    if (typeof masked.dulidayToken === 'string' && masked.dulidayToken) {
      const tail = masked.dulidayToken.slice(-4);
      masked.dulidayToken = `***${tail}`;
    }
    members[botImId] = masked;
  }
  return { ...config, members };
}

async function fetchGroupBots(strideBase, token) {
  const url = `${strideBase.replace(/\/+$/, '')}/api/v1/bot/getGroupBots?token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const json = await resp.json();
  let cur = json;
  while (cur && typeof cur === 'object' && 'data' in cur) cur = cur.data;
  const groups = Array.isArray(cur?.groups) ? cur.groups : [];
  const bots = [];
  for (const g of groups) {
    for (const b of g.bots || []) {
      bots.push({
        wxid: (b.wxid || '').trim(),
        wecomUserId: (b.wecomUserId || '').trim(),
        name: (b.name || '').trim(),
        groupId: (g.id || '').trim(),
        groupName: (g.name || '').trim(),
      });
    }
  }
  return bots;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.env);

  const url = requireEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const strideToken = requireEnv('STRIDE_ENTERPRISE_TOKEN');
  const strideBase = process.env.STRIDE_ENTERPRISE_API_BASE_URL || DEFAULT_STRIDE_BASE;

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`\n=== 生成 hosting_member_config ===`);
  console.log(`模式: ${args.apply ? '⚠️ APPLY（写库）' : 'DRY-RUN（只打印）'}`);
  console.log(`库:   ${url}`);
  console.log(`Stride: ${strideBase}`);

  const [bots, spongeRow] = await Promise.all([
    fetchGroupBots(strideBase, strideToken),
    client
      .from('system_config')
      .select('value')
      .eq('key', SPONGE_TOKEN_CONFIG_KEY)
      .maybeSingle()
      .then((r) => r.data?.value ?? null),
  ]);
  const tokenResolver = buildTokenResolver(
    typeof spongeRow === 'string' ? JSON.parse(spongeRow) : spongeRow,
  );

  const members = {};
  const unmatchedReceivers = new Set(Object.keys(BOT_TO_RECEIVER));
  for (const bot of bots) {
    if (!bot.wxid) continue;
    const receiver = BOT_TO_RECEIVER[bot.wxid];
    if (receiver) unmatchedReceivers.delete(bot.wxid);
    const token = tokenResolver({
      botImId: bot.wxid,
      botUserId: bot.wecomUserId,
      groupId: bot.groupId,
    });
    const entry = {};
    if (receiver?.openId) {
      entry.feishuOpenId = receiver.openId;
      entry.feishuName = receiver.name;
    }
    if (token) entry.dulidayToken = token;
    if (Object.keys(entry).length > 0) members[bot.wxid] = entry;
  }

  const config = { members };
  console.log(`\n--- 生成结果（${Object.keys(members).length} 个 bot）---`);
  // 打印时脱敏 dulidayToken（海绵 token），避免泄露到终端/CI 日志；真实值只在 --apply 写库。
  console.log(JSON.stringify(redactTokens(config), null, 2));
  if (unmatchedReceivers.size > 0) {
    console.log(
      `\n⚠️ 以下飞书接收人 botImId 不在 Stride 当前账号列表里（可能已停用，请人工核对）：`,
    );
    for (const id of unmatchedReceivers) console.log(`  ${id} → ${BOT_TO_RECEIVER[id].name}`);
  }

  if (args.apply) {
    const { error } = await client.from('system_config').upsert(
      {
        key: HOSTING_MEMBER_CONFIG_KEY,
        value: config,
        description: '托管成员统一配置（飞书+海绵token）',
      },
      { onConflict: 'key' },
    );
    if (error) throw new Error(`写入失败: ${error.message}`);
    console.log(`\n写入完成: system_config.${HOSTING_MEMBER_CONFIG_KEY}\n`);
  } else {
    console.log(`\n这是 dry-run，没有写库。确认无误后加 --apply 写入。\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败:', err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveTokenValue,
  buildTokenResolver,
  redactTokens,
};
