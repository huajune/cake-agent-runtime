#!/usr/bin/env node

/**
 * 从旧 sponge_token_config 补齐缺失 token；飞书身份只在数据库维护。
 * 已有接收人、token、人设、运营接收人和扩展字段一律保留。
 * 首次切换版本前可一次性导入旧 FEISHU_TASK_OWNER_OPEN_IDS_JSON，导入后移除旧变量。
 * 默认 dry-run，--apply 使用乐观锁写入，避免覆盖并发配置更新。
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const HOSTING_MEMBER_CONFIG_KEY = 'hosting_member_config';
const SPONGE_TOKEN_CONFIG_KEY = 'sponge_token_config';
const DEFAULT_STRIDE_BASE = 'https://stride-bg.dpclouds.com/hub-api';

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

function mergeConfig(existing, bots, tokenResolver, legacyOwners) {
  if (
    existing.members !== undefined &&
    (!existing.members || typeof existing.members !== 'object' || Array.isArray(existing.members))
  ) {
    throw new Error('members 格式无效，停止同步');
  }
  for (const entry of Object.values(existing.members ?? {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('成员配置格式无效，停止同步');
  }
  const members = { ...(existing.members ?? {}) };
  for (const bot of bots) {
    if (!bot.wxid) continue;
    const entry = { ...(members[bot.wxid] ?? {}) };
    if (!entry.dulidayToken?.trim()) {
      const token = tokenResolver({
        botImId: bot.wxid,
        botUserId: bot.wecomUserId,
        groupId: bot.groupId,
      });
      if (token) entry.dulidayToken = token;
    }
    if (Object.keys(entry).length) members[bot.wxid] = entry;
  }
  const config = { ...existing, members };
  if (config.taskOwners === undefined && legacyOwners?.trim()) {
    let owners;
    try {
      owners = JSON.parse(legacyOwners);
    } catch {
      throw new Error('旧 Task 负责人配置 JSON 无效');
    }
    if (!owners || typeof owners !== 'object' || Array.isArray(owners))
      throw new Error('旧 Task 负责人配置必须是 object');
    const keys = ['supervisor', 'T4', 'T5', 'T8', 'default'];
    config.taskOwners = {};
    for (const key of keys) {
      if (owners[key] === undefined) continue;
      if (
        !Array.isArray(owners[key]) ||
        owners[key].some((id) => typeof id !== 'string' || !id.trim())
      )
        throw new Error('旧 Task 负责人列表无效');
      config.taskOwners[key] = owners[key].map((id) => id.trim());
    }
  }
  return config;
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

  const [bots, spongeRow, existingHostingRow] = await Promise.all([
    fetchGroupBots(strideBase, strideToken),
    client
      .from('system_config')
      .select('value')
      .eq('key', SPONGE_TOKEN_CONFIG_KEY)
      .maybeSingle()
      .then((r) => {
        if (r.error) throw new Error('读取配置失败，停止同步');
        return r.data?.value ?? null;
      }),
    client
      .from('system_config')
      .select('value')
      .eq('key', HOSTING_MEMBER_CONFIG_KEY)
      .maybeSingle()
      .then((r) => {
        if (r.error) throw new Error('读取配置失败，停止同步');
        return r.data?.value ?? null;
      }),
  ]);
  if (
    !existingHostingRow ||
    typeof existingHostingRow !== 'object' ||
    Array.isArray(existingHostingRow)
  ) {
    throw new Error('hosting_member_config 缺失或无效，请先执行数据库迁移');
  }
  const existingConfig = existingHostingRow;
  const tokenResolver = buildTokenResolver(
    typeof spongeRow === 'string' ? JSON.parse(spongeRow) : spongeRow,
  );

  const config = mergeConfig(
    existingConfig,
    bots,
    tokenResolver,
    process.env.FEISHU_TASK_OWNER_OPEN_IDS_JSON,
  );
  console.log(`\n--- 生成结果（${Object.keys(config.members).length} 个 bot）---`);
  console.log(JSON.stringify(redactTokens(config), null, 2));

  if (args.apply) {
    // 配置必须由迁移创建，禁止读取失败/缺行后覆盖整个生产配置。
    const { data, error } = await client
      .from('system_config')
      .update({ value: config, updated_at: new Date().toISOString() })
      .eq('key', HOSTING_MEMBER_CONFIG_KEY)
      .eq('value', JSON.stringify(existingHostingRow))
      .select('key');
    if (error) throw new Error(`写入失败: ${error.code || '数据库请求失败'}`);
    if (data?.length !== 1) throw new Error('配置已被并发修改，请重新预览后再执行');
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
  mergeConfig,
};
