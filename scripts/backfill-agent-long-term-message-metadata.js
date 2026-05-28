#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONTACT_TYPE_TO_NUM = {
  UNKNOWN: 0,
  PERSONAL_WECHAT: 1,
  OFFICIAL_ACCOUNT: 2,
  ENTERPRISE_WECHAT: 3,
};

function parseArgs(argv) {
  const args = {
    env: '.env.local',
    dryRun: true,
    limit: null,
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
    } else if (key === '--apply') {
      args.dryRun = false;
    } else if (key === '--dry-run') {
      args.dryRun = true;
    } else if (key === '--help' || key === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/backfill-agent-long-term-message-metadata.js [options]

Options:
  --env <file>    Env file to load, default .env.local
  --dry-run       Count recoverable rows only, default
  --apply         Update agent_long_term_memories.message_metadata
  --limit <n>     Limit rows scanned

Notes:
  The script rebuilds message_metadata from the latest matching chat_messages
  row. It prints counts only and does not print candidate values.
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
  return value !== null && value !== undefined && !(typeof value === 'string' && !value.trim());
}

function compactObject(value) {
  const result = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (hasValue(fieldValue)) result[key] = fieldValue;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function buildMetadata(message) {
  return compactObject({
    botId: message.bot_id,
    imBotId: message.im_bot_id,
    imContactId: message.im_contact_id,
    contactType:
      typeof message.contact_type === 'string'
        ? CONTACT_TYPE_TO_NUM[message.contact_type]
        : message.contact_type,
    contactName: message.candidate_name,
    externalUserId: message.external_user_id,
    avatar: message.avatar,
  });
}

async function findLatestChatMessage(client, row) {
  const selectors = ['im_contact_id', 'external_user_id', 'chat_id'];
  const candidates = [];

  for (const selector of selectors) {
    let query = client
      .from('chat_messages')
      .select(
        'chat_id,org_id,bot_id,im_bot_id,im_contact_id,contact_type,candidate_name,external_user_id,avatar,timestamp',
      )
      .eq(selector, row.user_id)
      .order('timestamp', { ascending: false })
      .limit(1);

    if (row.corp_id && row.corp_id !== 'default') {
      query = query.eq('org_id', row.corp_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (data?.[0]) candidates.push(data[0]);
  }

  candidates.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return candidates[0] ?? null;
}

async function fetchTargetRows(client, limit) {
  let query = client
    .from('agent_long_term_memories')
    .select('corp_id,user_id')
    .is('message_metadata', null)
    .order('updated_at', { ascending: false });

  if (limit != null) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

async function applyMetadata(client, row, metadata) {
  const { error } = await client
    .from('agent_long_term_memories')
    .update({
      message_metadata: metadata,
      updated_at: new Date().toISOString(),
    })
    .eq('corp_id', row.corp_id)
    .eq('user_id', row.user_id)
    .is('message_metadata', null);

  if (error) throw error;
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
    matchedChatRows: 0,
    recoverableRows: 0,
    updatedRows: 0,
    missingChatRows: 0,
    emptyMetadataRows: 0,
    errors: 0,
  };

  const rows = await fetchTargetRows(client, args.limit);
  for (const row of rows) {
    stats.scannedRows += 1;
    try {
      const message = await findLatestChatMessage(client, row);
      if (!message) {
        stats.missingChatRows += 1;
        continue;
      }
      stats.matchedChatRows += 1;

      const metadata = buildMetadata(message);
      if (!metadata) {
        stats.emptyMetadataRows += 1;
        continue;
      }
      stats.recoverableRows += 1;

      if (!args.dryRun) {
        await applyMetadata(client, row, metadata);
        stats.updatedRows += 1;
      }
    } catch (error) {
      stats.errors += 1;
      console.error(
        `[backfill-agent-long-term-message-metadata] row failed: corp=${row.corp_id} user=${row.user_id} reason=${error.message}`,
      );
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[backfill-agent-long-term-message-metadata] ${error.message}`);
  process.exit(1);
});
