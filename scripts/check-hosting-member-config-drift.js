#!/usr/bin/env node

/** 检查数据库接收人配置完整性；不再与代码名单比较或覆盖 DB。 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const HOSTING_MEMBER_CONFIG_KEY = 'hosting_member_config';

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

function validateConfig(config) {
  const issues = [];
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v) => typeof v === 'string' && v.trim() !== '';
  if (!object(config) || !object(config.members))
    return { ok: false, memberCount: 0, issues: ['members 缺失或无效'] };
  for (const [id, entry] of Object.entries(config.members)) {
    if (!object(entry)) {
      issues.push(`${id}: 成员格式无效`);
      continue;
    }
    for (const key of ['feishuOpenId', 'feishuName', 'dulidayToken', 'wecomNickname', 'gender']) {
      if (entry[key] !== undefined && typeof entry[key] !== 'string')
        issues.push(`${id}: ${key} 必须是字符串`);
    }
    if (!text(entry.feishuOpenId)) issues.push(`${id}: 未配置飞书接收人`);
  }
  if (!Array.isArray(config.operationsReceivers))
    issues.push('operationsReceivers 缺失或无效，请先执行接收人迁移');
  else if (
    config.operationsReceivers.some(
      (r) => !object(r) || !text(r.openId) || typeof r.name !== 'string',
    )
  )
    issues.push('operationsReceivers 含无效接收人');
  if (config.taskOwners !== undefined) {
    if (!object(config.taskOwners)) issues.push('taskOwners 必须是 object');
    else
      for (const key of ['supervisor', 'T4', 'T5', 'T8', 'default']) {
        const ids = config.taskOwners[key];
        if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => !text(id))))
          issues.push(`taskOwners.${key} 无效`);
      }
  }
  return { ok: issues.length === 0, memberCount: Object.keys(config.members).length, issues };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.env);

  const url = requireEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await client
    .from('system_config')
    .select('value')
    .eq('key', HOSTING_MEMBER_CONFIG_KEY)
    .maybeSingle();
  if (error) throw new Error(`读取 ${HOSTING_MEMBER_CONFIG_KEY} 失败: ${error.message}`);

  const result = validateConfig(data?.value ?? null);
  if (
    process.env.FEISHU_TASK_OWNER_OPEN_IDS_JSON?.trim() &&
    data?.value?.taskOwners === undefined
  ) {
    result.ok = false;
    result.issues.push('旧 Task 负责人环境变量尚未迁入 taskOwners，请先运行 sync 预览/导入');
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok)
    console.log(`hosting_member_config OK: ${result.memberCount} 个数据库成员；接收人配置完整。`);
  else for (const issue of result.issues) console.error(issue);

  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败:', err);
    process.exit(1);
  });
}

module.exports = { validateConfig };
