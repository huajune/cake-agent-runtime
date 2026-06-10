#!/usr/bin/env node

/**
 * 存量清洗：截断 agent_long_term_memories.profile_facts 中的超长 evidence。
 *
 * 背景：会话沉淀曾把 LLM 提取 reasoning 全文（600+ 字）作为 evidence 永久写入
 * 长期画像，并随每轮注入 system prompt（张漪 case，chat 69a13e919d6d3a463b0a37c6）。
 * 写入侧已在 fix/memory-hygiene 截断（truncateEvidence，200 字），本脚本处理存量。
 *
 * 用法（与 backfill-agent-long-term-memories.js 同约定，默认 dry-run）：
 *   node scripts/cleanup-profile-evidence.js --env .env.local        # 测试库试跑
 *   node scripts/cleanup-profile-evidence.js --env .env.local --apply
 *   node scripts/cleanup-profile-evidence.js --env .env.production --apply
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const MAX_EVIDENCE_CHARS = 200;
const PAGE_SIZE = 500;

function parseArgs(argv) {
  const args = { env: '.env.local', dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--env' && value) {
      args.env = value;
      i += 1;
    } else if (key === '--apply') {
      args.dryRun = false;
    } else if (key === '--dry-run') {
      args.dryRun = true;
    } else if (key === '--help' || key === '-h') {
      console.log(
        'Usage: node scripts/cleanup-profile-evidence.js [--env <file>] [--dry-run|--apply]',
      );
      process.exit(0);
    }
  }
  return args;
}

function loadEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    console.error(`env file not found: ${absolute}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function truncateEvidence(evidence) {
  const trimmed = evidence.trim();
  if (trimmed.length <= MAX_EVIDENCE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_EVIDENCE_CHARS)}…`;
}

/** 返回 null 表示该行无需清洗。 */
function cleanProfileFacts(profileFacts) {
  if (!profileFacts || typeof profileFacts !== 'object') return null;
  let changed = false;
  const next = {};
  for (const [field, value] of Object.entries(profileFacts)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof value.evidence === 'string' &&
      value.evidence.length > MAX_EVIDENCE_CHARS
    ) {
      next[field] = { ...value, evidence: truncateEvidence(value.evidence) };
      changed = true;
    } else {
      next[field] = value;
    }
  }
  return changed ? next : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.env);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  console.log(`env=${args.env} url=${url} mode=${args.dryRun ? 'DRY-RUN' : 'APPLY'}`);

  const client = createClient(url, key, { auth: { persistSession: false } });

  let scanned = 0;
  let polluted = 0;
  let updated = 0;
  let from = 0;

  for (;;) {
    const { data, error } = await client
      .from('agent_long_term_memories')
      .select('corp_id, user_id, profile_facts')
      .not('profile_facts', 'is', null)
      .order('corp_id', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error('select failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned += 1;
      const cleaned = cleanProfileFacts(row.profile_facts);
      if (!cleaned) continue;
      polluted += 1;

      const longFields = Object.entries(row.profile_facts)
        .filter(
          ([, v]) => v && typeof v === 'object' && (v.evidence?.length ?? 0) > MAX_EVIDENCE_CHARS,
        )
        .map(([f, v]) => `${f}(${v.evidence.length})`);
      console.log(`- ${row.corp_id}/${row.user_id}: ${longFields.join(', ')}`);

      if (args.dryRun) continue;
      const { error: updateError } = await client
        .from('agent_long_term_memories')
        .update({ profile_facts: cleaned })
        .eq('corp_id', row.corp_id)
        .eq('user_id', row.user_id);
      if (updateError) {
        console.error(`  update failed for ${row.corp_id}/${row.user_id}:`, updateError.message);
      } else {
        updated += 1;
      }
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(
    `done: scanned=${scanned} polluted=${polluted} ${args.dryRun ? '(dry-run, no writes)' : `updated=${updated}`}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
