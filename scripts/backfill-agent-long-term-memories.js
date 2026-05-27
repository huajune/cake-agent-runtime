#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PROFILE_FIELDS = [
  'name',
  'phone',
  'gender',
  'age',
  'is_student',
  'education',
  'has_health_certificate',
];

const VALID_CONFIDENCE = new Set(['high', 'medium', 'low', 'unknown']);
const VALID_SOURCE = new Set([
  'candidate',
  'llm',
  'rule',
  'system',
  'memory',
  'derived',
  'booking',
  'extraction',
  'enrichment',
]);

function parseArgs(argv) {
  const args = {
    env: '.env.local',
    dryRun: true,
    limit: null,
    pageSize: 500,
    overwriteSummary: false,
    corpId: null,
    userId: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === '--env' && value) {
      args.env = value;
      i += 1;
    } else if (key === '--limit' && value) {
      args.limit = Number(value);
      i += 1;
    } else if (key === '--page-size' && value) {
      args.pageSize = Number(value);
      i += 1;
    } else if (key === '--apply') {
      args.dryRun = false;
    } else if (key === '--dry-run') {
      args.dryRun = true;
    } else if (key === '--overwrite-summary') {
      args.overwriteSummary = true;
    } else if (key === '--corp-id' && value) {
      args.corpId = value;
      i += 1;
    } else if (key === '--user-id' && value) {
      args.userId = value;
      i += 1;
    } else if (key === '--help' || key === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/backfill-agent-long-term-memories.js [options]

Options:
  --env <file>            Env file to load, default .env.local
  --dry-run               Count and validate only, default
  --apply                 Write migrated rows into agent_long_term_memories
  --limit <n>             Limit old rows scanned
  --page-size <n>         Supabase page size, default 500
  --corp-id <id>          Restrict scan to one corp_id
  --user-id <id>          Restrict scan to one user_id
  --overwrite-summary     Replace existing target summary_data when applying

Notes:
  Profile fields are written through upsert_long_term_profile_facts, so an
  existing high-confidence value in agent_long_term_memories is not overwritten
  by lower-confidence historical data.
`);
}

function loadEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) return;

  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function requireEnv(name, fallbackName) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    throw new Error(`Missing env ${name}${fallbackName ? ` or ${fallbackName}` : ''}`);
  }
  return value;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function normalizeConfidence(value) {
  return VALID_CONFIDENCE.has(value) ? value : 'unknown';
}

function normalizeSource(value) {
  return VALID_SOURCE.has(value) ? value : 'memory';
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta;
}

function buildProfileFacts(row) {
  const metaByField = normalizeMeta(row.profile_fields_meta);
  const facts = {};
  const updatedAtFallback = row.updated_at || new Date().toISOString();

  for (const field of PROFILE_FIELDS) {
    const value = row[field];
    if (!hasValue(value)) continue;

    const meta = normalizeMeta(metaByField[field]);
    const confidence = normalizeConfidence(meta.confidence);
    const source = normalizeSource(meta.source);
    const updatedAt = meta.writtenAt || meta.updatedAt || updatedAtFallback;

    facts[field] = {
      value,
      confidence,
      source,
      evidence: buildEvidence(field, meta),
      updatedAt,
    };
  }

  return facts;
}

function buildEvidence(field, meta) {
  const parts = ['history agent_memories backfill', `field=${field}`];
  if (meta.source) parts.push(`legacySource=${meta.source}`);
  if (meta.confidence) parts.push(`legacyConfidence=${meta.confidence}`);
  return parts.join('; ');
}

function normalizeSummaryData(summaryData) {
  if (!summaryData || typeof summaryData !== 'object' || Array.isArray(summaryData)) return null;
  return {
    recent: Array.isArray(summaryData.recent) ? summaryData.recent : [],
    archive: typeof summaryData.archive === 'string' ? summaryData.archive : null,
    lastSettledMessageAt:
      typeof summaryData.lastSettledMessageAt === 'string'
        ? summaryData.lastSettledMessageAt
        : null,
  };
}

function hasSummaryData(summaryData) {
  if (!summaryData) return false;
  return (
    (Array.isArray(summaryData.recent) && summaryData.recent.length > 0) ||
    Boolean(summaryData.archive) ||
    Boolean(summaryData.lastSettledMessageAt)
  );
}

async function fetchOldRows(client, offset, pageSize, limit, filters) {
  const pageLimit = limit == null ? pageSize : Math.min(pageSize, Math.max(limit - offset, 0));
  if (pageLimit <= 0) return [];

  let query = client
    .from('agent_memories')
    .select(
      [
        'corp_id',
        'user_id',
        ...PROFILE_FIELDS,
        'summary_data',
        'message_metadata',
        'profile_fields_meta',
        'updated_at',
      ].join(','),
    )
    .order('updated_at', { ascending: true });

  if (filters.corpId) query = query.eq('corp_id', filters.corpId);
  if (filters.userId) query = query.eq('user_id', filters.userId);

  const { data, error } = await query.range(offset, offset + pageLimit - 1);

  if (error) throw error;
  return data || [];
}

async function getTargetRow(client, corpId, userId) {
  const { data, error } = await client
    .from('agent_long_term_memories')
    .select('profile_facts,summary_data,message_metadata')
    .eq('corp_id', corpId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function applyProfileFacts(client, row, profileFacts) {
  const { data, error } = await client.rpc('upsert_long_term_profile_facts', {
    p_corp_id: row.corp_id,
    p_user_id: row.user_id,
    p_profile_facts: profileFacts,
    p_message_metadata: row.message_metadata || null,
  });

  if (error) throw error;
  return data || { written_fields: [], skipped_fields: [] };
}

async function applySummaryData(client, row, summaryData, overwriteSummary) {
  const target = await getTargetRow(client, row.corp_id, row.user_id);
  const targetHasSummary = hasSummaryData(normalizeSummaryData(target?.summary_data));
  if (targetHasSummary && !overwriteSummary) return { written: false, skipped: true };

  const payload = {
    corp_id: row.corp_id,
    user_id: row.user_id,
    summary_data: summaryData,
    message_metadata: row.message_metadata || target?.message_metadata || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await client
    .from('agent_long_term_memories')
    .upsert(payload, { onConflict: 'corp_id,user_id' });

  if (error) throw error;
  return { written: true, skipped: false };
}

async function applyMetadataOnly(client, row) {
  if (!row.message_metadata) return false;

  const { error } = await client
    .from('agent_long_term_memories')
    .upsert(
      {
        corp_id: row.corp_id,
        user_id: row.user_id,
        message_metadata: row.message_metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'corp_id,user_id' },
    );

  if (error) throw error;
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.env);

  const url = requireEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stats = {
    mode: args.dryRun ? 'dry-run' : 'apply',
    scannedRows: 0,
    rowsWithProfileFacts: 0,
    rowsWithSummaryData: 0,
    rowsWithMetadataOnly: 0,
    profileFieldsPrepared: 0,
    profileFieldsWritten: 0,
    profileFieldsSkippedByGuard: 0,
    summariesWritten: 0,
    summariesSkippedExisting: 0,
    metadataRowsWritten: 0,
    errors: 0,
  };

  for (let offset = 0; ; offset += args.pageSize) {
    const rows = await fetchOldRows(client, offset, args.pageSize, args.limit, {
      corpId: args.corpId,
      userId: args.userId,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      stats.scannedRows += 1;
      const profileFacts = buildProfileFacts(row);
      const summaryData = normalizeSummaryData(row.summary_data);
      const hasProfileFacts = Object.keys(profileFacts).length > 0;
      const hasSummary = hasSummaryData(summaryData);
      const hasMetadataOnly = !hasProfileFacts && !hasSummary && Boolean(row.message_metadata);

      if (hasProfileFacts) stats.rowsWithProfileFacts += 1;
      if (hasSummary) stats.rowsWithSummaryData += 1;
      if (hasMetadataOnly) stats.rowsWithMetadataOnly += 1;
      stats.profileFieldsPrepared += Object.keys(profileFacts).length;

      if (args.dryRun) continue;

      try {
        if (hasProfileFacts) {
          const result = await applyProfileFacts(client, row, profileFacts);
          stats.profileFieldsWritten += Array.isArray(result.written_fields)
            ? result.written_fields.length
            : 0;
          stats.profileFieldsSkippedByGuard += Array.isArray(result.skipped_fields)
            ? result.skipped_fields.length
            : 0;
        }

        if (hasSummary) {
          const result = await applySummaryData(client, row, summaryData, args.overwriteSummary);
          if (result.written) stats.summariesWritten += 1;
          if (result.skipped) stats.summariesSkippedExisting += 1;
        } else if (hasMetadataOnly) {
          const written = await applyMetadataOnly(client, row);
          if (written) stats.metadataRowsWritten += 1;
        }
      } catch (error) {
        stats.errors += 1;
        console.error(
          `[backfill-agent-long-term-memories] row failed: corp=${row.corp_id} user=${row.user_id} reason=${error.message}`,
        );
      }
    }

    if (rows.length < args.pageSize || (args.limit != null && stats.scannedRows >= args.limit)) {
      break;
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[backfill-agent-long-term-memories] ${error.message}`);
  process.exit(1);
});
