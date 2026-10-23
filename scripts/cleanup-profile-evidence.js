#!/usr/bin/env node

/**
 * 存量清洗：截断 agent_long_term_memories 画像和意向中的超长 evidence。
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
  const characters = Array.from(evidence.trim());
  if (characters.length <= MAX_EVIDENCE_CHARS) return characters.join('');
  return `${characters.slice(0, MAX_EVIDENCE_CHARS - 1).join('')}…`;
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
      Array.from(value.evidence).length > MAX_EVIDENCE_CHARS
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
      .select('id, updated_at, semantic_profile, semantic_job_intent')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error('select failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned += 1;
      const patch = {};
      for (const column of ['semantic_profile', 'semantic_job_intent']) {
        const cleaned = cleanProfileFacts(row[column]);
        if (cleaned) patch[column] = cleaned;
      }
      if (Object.keys(patch).length === 0) continue;
      polluted += 1;

      console.log(`- ${row.id}: ${Object.keys(patch).join(', ')}`);

      if (args.dryRun) continue;
      const { data: changed, error: updateError } = await client
        .from('agent_long_term_memories')
        .update(patch)
        .eq('id', row.id)
        .eq('updated_at', row.updated_at)
        .select('id');
      if (updateError) {
        throw new Error(`update failed for ${row.id}: ${updateError.message}`);
      } else if (changed?.length === 1) {
        updated += 1;
      } else {
        console.warn(`  skipped concurrent update: ${row.id}`);
      }
    }

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(
    `done: scanned=${scanned} polluted=${polluted} ${args.dryRun ? '(dry-run, no writes)' : `updated=${updated}`}`,
  );
}

module.exports = { truncateEvidence, cleanProfileFacts };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
