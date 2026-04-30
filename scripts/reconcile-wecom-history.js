#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_ENV_FILE = '.env.production';
const DEFAULT_LOOKBACK_MINUTES = 10;

function parseArgs(argv) {
  const args = {
    env: DEFAULT_ENV_FILE,
    lookbackMinutes: DEFAULT_LOOKBACK_MINUTES,
    snapshotDay: undefined,
    dryRun: false,
    tokens: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === '--env' && value) {
      args.env = value;
      i += 1;
    } else if (key === '--lookback-minutes' && value) {
      args.lookbackMinutes = Number(value);
      i += 1;
    } else if (key === '--snapshot-day' && value) {
      args.snapshotDay = value;
      i += 1;
    } else if (key === '--tokens' && value) {
      args.tokens = value;
      i += 1;
    } else if (key === '--dry-run') {
      args.dryRun = true;
    } else if (key === '--help' || key === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.lookbackMinutes) || args.lookbackMinutes <= 0) {
    throw new Error('--lookback-minutes must be a positive number');
  }

  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/reconcile-wecom-history.js [options]

Options:
  --env <file>                 Env file, default ${DEFAULT_ENV_FILE}
  --lookback-minutes <number>  Recent window to reconcile, default ${DEFAULT_LOOKBACK_MINUTES}
  --snapshot-day <YYYY-MM-DD>  Override Stride snapshot day, default derived from window
  --tokens <name:token,...>    Override WECOM_HISTORY_TOKENS/GROUP_TASK_TOKENS
  --dry-run                    Print missing rows without inserting
`);
}

function loadEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Env file not found: ${absolute}`);
  }

  const env = {};
  const content = fs.readFileSync(absolute, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { ...process.env, ...env };
}

function parseTokenPairs(raw) {
  return String(raw || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf(':');
      if (index === -1) return { name: 'default', token: pair.trim() };
      return {
        name: pair.slice(0, index).trim(),
        token: pair.slice(index + 1).trim(),
      };
    })
    .filter((item) => item.token);
}

function formatLocalDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function resolveSnapshotDays(start, end, override) {
  if (override) return [override];
  const days = new Set([formatLocalDay(start), formatLocalDay(end)]);
  return [...days];
}

function messageContent(row) {
  const payload = row.payload || {};
  if (typeof payload.pureText === 'string') return payload.pureText;
  if (typeof payload.text === 'string') return payload.text;
  return '';
}

function toStorageMessageType(type) {
  const map = {
    0: 'UNKNOWN',
    1: 'FILE',
    2: 'VOICE',
    3: 'CONTACT_CARD',
    4: 'CHAT_HISTORY',
    5: 'EMOTION',
    6: 'IMAGE',
    7: 'TEXT',
    8: 'LOCATION',
    9: 'MINI_PROGRAM',
    10: 'MONEY',
    11: 'REVOKE',
    12: 'LINK',
    13: 'VIDEO',
    14: 'CHANNELS',
    15: 'CALL_RECORD',
    16: 'GROUP_SOLITAIRE',
    9999: 'ROOM_INVITE',
    10000: 'SYSTEM',
    10001: 'WECOM_SYSTEM',
  };
  return map[type] || 'UNKNOWN';
}

async function fetchHistoryRows({ baseUrl, token, snapshotDay }) {
  const rows = [];
  let seq;

  for (let page = 0; page < 300; page += 1) {
    const params = {
      token,
      pageSize: 100,
      snapshotDay,
    };
    if (seq) params.seq = seq;

    const response = await axios.get(`${baseUrl}/stream-api/message/history`, {
      params,
      timeout: 30_000,
    });
    const body = response.data || {};
    if (body.code !== 0 && body.errcode !== 0 && body.code !== undefined) {
      throw new Error(body.message || body.errmsg || `message/history failed for ${snapshotDay}`);
    }

    const pageRows = Array.isArray(body.data) ? body.data : [];
    rows.push(...pageRows);

    if (!body.seq || body.seq === seq || pageRows.length === 0) break;
    seq = body.seq;
  }

  return rows;
}

async function fetchExistingMessageIds(client, ids) {
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await client.from('chat_messages').select('message_id').in('message_id', chunk);
    if (error) throw error;
    for (const row of data || []) existing.add(row.message_id);
  }
  return existing;
}

async function fetchDuplicateKeys(client, candidates) {
  const keys = new Set();
  const chatIds = [...new Set(candidates.map((row) => row.chatId).filter(Boolean))];
  if (chatIds.length === 0) return keys;

  const timestamps = candidates.map((row) => Number(row.timestamp)).filter(Number.isFinite);
  if (timestamps.length === 0) return keys;

  const start = new Date(Math.min(...timestamps) - 1000).toISOString();
  const end = new Date(Math.max(...timestamps) + 1000).toISOString();
  const { data, error } = await client
    .from('chat_messages')
    .select('chat_id,content,timestamp,role')
    .in('chat_id', chatIds)
    .gte('timestamp', start)
    .lte('timestamp', end);
  if (error) throw error;

  for (const row of data || []) {
    keys.add(buildDuplicateKey(row.chat_id, row.role, row.content, new Date(row.timestamp).getTime()));
  }
  return keys;
}

function buildDuplicateKey(chatId, role, content, timestamp) {
  return `${chatId}|${role}|${timestamp}|${content}`;
}

async function fetchChatMetadata(client, chatIds) {
  const metadata = new Map();
  if (chatIds.length === 0) return metadata;

  const { data, error } = await client
    .from('chat_messages')
    .select('chat_id,org_id,bot_id,manager_name,im_bot_id')
    .in('chat_id', chatIds)
    .order('timestamp', { ascending: true });
  if (error) throw error;

  for (const row of data || []) {
    if (!metadata.has(row.chat_id)) {
      metadata.set(row.chat_id, {
        orgId: row.org_id,
        botId: row.bot_id,
        managerName: row.manager_name,
        imBotId: row.im_bot_id,
      });
    }
  }
  return metadata;
}

function toChatMessageRecord(row, metadata) {
  const content = messageContent(row);
  const chatMeta = metadata.get(row.chatId) || {};
  const timestamp = Number(row.timestamp);
  return {
    chat_id: row.chatId,
    message_id: row.messageId,
    role: 'user',
    content,
    timestamp: new Date(timestamp).toISOString(),
    candidate_name: row.contactName,
    manager_name: row.botWeixin || chatMeta.managerName,
    org_id: chatMeta.orgId || 'group_callback_org',
    bot_id: row.botId || chatMeta.botId,
    message_type: toStorageMessageType(row.type),
    source: 'MOBILE_PUSH',
    is_room: false,
    im_bot_id: row.botWxid || chatMeta.imBotId,
    im_contact_id: row.contactId,
    contact_type: 'PERSONAL_WECHAT',
    is_self: false,
    payload: row.payload || { text: content, pureText: content },
    avatar: row.avatar,
    external_user_id: row.externalUserId || null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnvFile(args.env);
  const tokens = parseTokenPairs(args.tokens || env.WECOM_HISTORY_TOKENS || env.GROUP_TASK_TOKENS);
  if (tokens.length === 0) {
    throw new Error('No WECOM_HISTORY_TOKENS or GROUP_TASK_TOKENS configured');
  }

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const strideBaseUrl = env.STRIDE_API_BASE_URL;
  if (!supabaseUrl || !serviceRoleKey || !strideBaseUrl) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or STRIDE_API_BASE_URL');
  }

  const now = new Date();
  const start = new Date(now.getTime() - args.lookbackMinutes * 60_000);
  const snapshotDays = resolveSnapshotDays(start, now, args.snapshotDay);
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const upstreamRows = [];
  for (const pair of tokens) {
    for (const snapshotDay of snapshotDays) {
      const rows = await fetchHistoryRows({
        baseUrl: strideBaseUrl,
        token: pair.token,
        snapshotDay,
      });
      upstreamRows.push(...rows.map((row) => ({ ...row, _groupName: pair.name, _snapshotDay: snapshotDay })));
    }
  }

  const candidates = upstreamRows.filter((row) => {
    const timestamp = Number(row.timestamp);
    return (
      Number.isFinite(timestamp) &&
      timestamp >= start.getTime() &&
      timestamp <= now.getTime() &&
      row.isSelf === false &&
      row.contactType === 1 &&
      row.type === 7 &&
      !row.roomId &&
      Boolean(row.messageId) &&
      Boolean(row.chatId) &&
      messageContent(row).trim().length > 0
    );
  });

  const existingIds = await fetchExistingMessageIds(
    client,
    candidates.map((row) => row.messageId),
  );
  const duplicateKeys = await fetchDuplicateKeys(client, candidates);
  const missing = candidates.filter((row) => {
    if (existingIds.has(row.messageId)) return false;
    const key = buildDuplicateKey(row.chatId, 'user', messageContent(row), Number(row.timestamp));
    return !duplicateKeys.has(key);
  });

  const metadata = await fetchChatMetadata(
    client,
    [...new Set(missing.map((row) => row.chatId))],
  );
  const records = missing.map((row) => toChatMessageRecord(row, metadata));

  let inserted = [];
  if (!args.dryRun && records.length > 0) {
    const { data, error } = await client
      .from('chat_messages')
      .upsert(records, { onConflict: 'message_id', ignoreDuplicates: true })
      .select('message_id,chat_id,content,timestamp,candidate_name,manager_name');
    if (error) throw error;
    inserted = data || [];
  }

  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        lookbackMinutes: args.lookbackMinutes,
        window: {
          start: start.toISOString(),
          end: now.toISOString(),
          snapshotDays,
        },
        tokenGroups: tokens.map((item) => item.name),
        upstreamRows: upstreamRows.length,
        candidates: candidates.length,
        missing: missing.length,
        inserted: inserted.length,
        missingPreview: missing.slice(0, 20).map((row) => ({
          messageId: row.messageId,
          chatId: row.chatId,
          contactName: row.contactName,
          groupName: row._groupName,
          timestamp: new Date(Number(row.timestamp)).toISOString(),
          content: messageContent(row),
        })),
        insertedRows: inserted,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
