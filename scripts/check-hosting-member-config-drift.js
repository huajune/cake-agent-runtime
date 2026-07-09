#!/usr/bin/env node

/**
 * Compare code-owned Feishu receiver mappings with runtime hosting_member_config.
 *
 * This catches the release gap where Supabase migrations are up to date, but
 * system_config.hosting_member_config was not seeded/synced for a new bot.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const HOSTING_MEMBER_CONFIG_KEY = 'hosting_member_config';
const RECEIVERS_FILE = path.resolve(__dirname, '../src/infra/feishu/constants/receivers.ts');

function parseArgs(argv) {
  const args = { env: '.env.local', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env' && argv[i + 1]) {
      args.env = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') {
      args.json = true;
    }
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

function parseCodeMappings() {
  const source = fs.readFileSync(RECEIVERS_FILE, 'utf8');
  const userEntries = new Map();
  const userRegex =
    /([A-Z0-9_]+):\s*\{\s*openId:\s*'([^']+)'\s*,\s*name:\s*'([^']+)'\s*\}/g;
  for (const match of source.matchAll(userRegex)) {
    userEntries.set(match[1], { openId: match[2], name: match[3] });
  }

  const botEntries = {};
  const botRegex = /'([^']+)':\s*FEISHU_RECEIVER_USERS\.([A-Z0-9_]+)/g;
  for (const match of source.matchAll(botRegex)) {
    const receiver = userEntries.get(match[2]);
    if (!receiver) throw new Error(`BOT_TO_RECEIVER 引用了未知接收人: ${match[2]}`);
    botEntries[match[1]] = receiver;
  }
  return botEntries;
}

function compare(expected, actualConfig) {
  const members = actualConfig?.members && typeof actualConfig.members === 'object'
    ? actualConfig.members
    : {};
  const missing = [];
  const mismatched = [];

  for (const [botImId, receiver] of Object.entries(expected)) {
    const entry = members[botImId];
    if (!entry) {
      missing.push({ botImId, expectedName: receiver.name });
      continue;
    }
    const actualOpenId = typeof entry.feishuOpenId === 'string' ? entry.feishuOpenId.trim() : '';
    const actualName = typeof entry.feishuName === 'string' ? entry.feishuName.trim() : '';
    if (actualOpenId !== receiver.openId || (actualName && actualName !== receiver.name)) {
      mismatched.push({
        botImId,
        expectedName: receiver.name,
        actualName: actualName || null,
        expectedOpenIdTail: receiver.openId.slice(-6),
        actualOpenIdTail: actualOpenId ? actualOpenId.slice(-6) : null,
      });
    }
  }

  return {
    expectedCount: Object.keys(expected).length,
    actualCount: Object.keys(members).length,
    missing,
    mismatched,
    ok: missing.length === 0 && mismatched.length === 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.env);

  const url = requireEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const expected = parseCodeMappings();
  const { data, error } = await client
    .from('system_config')
    .select('value')
    .eq('key', HOSTING_MEMBER_CONFIG_KEY)
    .maybeSingle();
  if (error) throw new Error(`读取 ${HOSTING_MEMBER_CONFIG_KEY} 失败: ${error.message}`);

  const result = compare(expected, data?.value ?? null);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `hosting_member_config OK: ${result.actualCount} runtime members cover ${result.expectedCount} code mappings.`,
    );
  } else {
    console.error(
      `hosting_member_config drift: ${result.missing.length} missing, ${result.mismatched.length} mismatched.`,
    );
    for (const item of result.missing) {
      console.error(`  missing ${item.botImId} (${item.expectedName})`);
    }
    for (const item of result.mismatched) {
      console.error(
        `  mismatched ${item.botImId} (${item.expectedName}): openId tail ${item.actualOpenIdTail} != ${item.expectedOpenIdTail}`,
      );
    }
  }

  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败:', err);
    process.exit(1);
  });
}
