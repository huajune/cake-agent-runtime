#!/usr/bin/env node
/**
 * Sync handoff_events + related chat history to a Feishu Bitable for ops analysis.
 *
 * Usage:
 *   node scripts/sync-handoff-events-to-feishu.js --dry-run
 *   node scripts/sync-handoff-events-to-feishu.js --url "https://xxx.feishu.cn/base/<appToken>?table=<tableId>" --apply
 *   node scripts/sync-handoff-events-to-feishu.js --app-token <appToken> --table-id <tableId> --since 2026-06-01 --apply
 *
 * Target can also be supplied by env:
 *   FEISHU_HANDOFF_ANALYSIS_APP_TOKEN
 *   FEISHU_HANDOFF_ANALYSIS_TABLE_ID
 */

const fs = require('fs');
const path = require('path');

const FIELD_TYPES = {
  TEXT: 1,
  NUMBER: 2,
  SINGLE_SELECT: 3,
  DATE: 5,
};

const REASON_LABELS = {
  cannot_find_store: '找不到门店',
  no_reception: '到店无人接待',
  booking_conflict: '预约信息冲突',
  onboarding_paperwork: '入职办理异常',
  interview_result_inquiry: '候选人追问面试结果',
  modify_appointment: '候选人要求改期/取消已预约面试',
  self_recruited_or_completed: '候选人已被面试通过/餐厅自招/办入职',
  no_match_or_group_full: '无匹配岗位/群满需维护',
  system_blocked: '工具/系统卡死无法自助',
  other: '其他需人工处理场景',
};

const PRIMARY_EVENT_ID_FIELD = '事件ID（主键）';
const LEGACY_EVENT_ID_FIELD = '事件ID';
const DEFAULT_PRIMARY_FIELD_NAMES = ['Text', '文本'];
const EVENT_ID_LOOKUP_FIELDS = [
  PRIMARY_EVENT_ID_FIELD,
  LEGACY_EVENT_ID_FIELD,
  ...DEFAULT_PRIMARY_FIELD_NAMES,
];

const SCHEMA = [
  { name: PRIMARY_EVENT_ID_FIELD, type: FIELD_TYPES.TEXT, source: 'idempotency_key' },
  { name: '触发时间', type: FIELD_TYPES.DATE },
  { name: '原因代码', type: FIELD_TYPES.SINGLE_SELECT, options: Object.keys(REASON_LABELS) },
  { name: '原因分类', type: FIELD_TYPES.SINGLE_SELECT, options: Object.values(REASON_LABELS) },
  { name: '命中原因', type: FIELD_TYPES.TEXT },
  { name: '建议动作', type: FIELD_TYPES.TEXT },
  { name: '阶段', type: FIELD_TYPES.SINGLE_SELECT },
  { name: '会话ID', type: FIELD_TYPES.TEXT },
  { name: '候选人ID', type: FIELD_TYPES.TEXT },
  { name: '候选人微信昵称', type: FIELD_TYPES.TEXT },
  { name: '招募经理姓名', type: FIELD_TYPES.TEXT },
  { name: '托管账号ID', type: FIELD_TYPES.TEXT },
  { name: '工单ID', type: FIELD_TYPES.NUMBER },
  { name: '当前消息', type: FIELD_TYPES.TEXT },
  { name: '最近10条聊天', type: FIELD_TYPES.TEXT },
  { name: '完整聊天记录', type: FIELD_TYPES.TEXT },
  { name: '聊天消息数', type: FIELD_TYPES.NUMBER },
  { name: '首次聊天时间', type: FIELD_TYPES.DATE },
  { name: '最近聊天时间', type: FIELD_TYPES.DATE },
];

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: false,
    envPath: '.env.production',
    since: null,
    until: null,
    limit: null,
    url: null,
    appToken: null,
    tableId: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--env') args.envPath = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--until') args.until = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--url') args.url = argv[++i];
    else if (arg === '--app-token') args.appToken = argv[++i];
    else if (arg === '--table-id') args.tableId = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.apply) args.dryRun = true;
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/sync-handoff-events-to-feishu.js --dry-run
  node scripts/sync-handoff-events-to-feishu.js --url "https://xxx.feishu.cn/base/<appToken>?table=<tableId>" --apply
  node scripts/sync-handoff-events-to-feishu.js --app-token <appToken> --table-id <tableId> --since 2026-06-01 --apply

Options:
  --env <file>       Env file to load, default .env.production
  --since <date>     Include events created_at >= date. Example: 2026-06-01
  --until <date>     Include events created_at < date. Example: 2026-07-01
  --limit <n>        Limit handoff_events rows after ordering by created_at asc
  --dry-run          Build rows and print summary without writing Feishu
  --apply            Create missing fields and upsert records into Feishu
`);
}

function loadEnv(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return {};
  const env = {};

  for (const rawLine of fs.readFileSync(resolved, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

function parseTargetFromUrl(url) {
  if (!url) return {};
  const parsed = new URL(url);
  const tableId = parsed.searchParams.get('table') || parsed.searchParams.get('table_id');
  const segments = parsed.pathname.split('/').filter(Boolean);
  const baseIndex = segments.findIndex((part) => ['base', 'bitable'].includes(part));
  const appToken = baseIndex >= 0 ? segments[baseIndex + 1] : null;
  const wikiIndex = segments.findIndex((part) => part === 'wiki');
  const wikiToken = wikiIndex >= 0 ? segments[wikiIndex + 1] : null;

  return { appToken, tableId, wikiToken };
}

function requireConfig(env, args) {
  const fromUrl = parseTargetFromUrl(args.url);
  const appToken = args.appToken || fromUrl.appToken || env.FEISHU_HANDOFF_ANALYSIS_APP_TOKEN || '';
  const tableId = args.tableId || fromUrl.tableId || env.FEISHU_HANDOFF_ANALYSIS_TABLE_ID || '';
  const wikiToken = fromUrl.wikiToken || '';

  const missing = [];
  if (!env.FEISHU_APP_ID) missing.push('FEISHU_APP_ID');
  if (!env.FEISHU_APP_SECRET) missing.push('FEISHU_APP_SECRET');
  if (!env.NEXT_PUBLIC_SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!args.dryRun && !appToken && !wikiToken) {
    missing.push('FEISHU_HANDOFF_ANALYSIS_APP_TOKEN / --app-token / --url');
  }
  if (!args.dryRun && !tableId)
    missing.push('FEISHU_HANDOFF_ANALYSIS_TABLE_ID / --table-id / --url');

  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}`);
  }

  return {
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
    appToken,
    tableId,
    wikiToken,
  };
}

async function getTenantToken(config) {
  const response = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    },
  );
  const body = await response.json();
  if (body.code !== 0) throw new Error(`tenant_access_token failed: ${body.code} ${body.msg}`);
  return body.tenant_access_token;
}

async function resolveTargetFromWiki(token, config) {
  if (config.appToken || !config.wikiToken) return config;
  const data = await feishu(
    token,
    `/wiki/v2/spaces/get_node?token=${encodeURIComponent(config.wikiToken)}`,
  );
  const appToken = data.node?.obj_type === 'bitable' ? data.node?.obj_token : '';
  if (!appToken) {
    throw new Error(`Wiki node is not a bitable or cannot be resolved: ${config.wikiToken}`);
  }
  return { ...config, appToken };
}

async function feishu(token, pathName, options = {}) {
  const response = await fetch(`https://open.feishu.cn/open-apis${pathName}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (body.code !== 0) throw new Error(`${pathName} failed: ${body.code} ${body.msg}`);
  return body.data || {};
}

async function supabaseAll(config, table, params, pageSize = 1000) {
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${config.supabaseUrl}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        Range: `${offset}-${offset + pageSize - 1}`,
      },
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${table} query failed: ${response.status} ${text.slice(0, 500)}`);
    const page = JSON.parse(text);
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

function buildHandoffParams(args) {
  const params = {
    select:
      'id,chat_id,corp_id,user_id,reason_code,reason,action_advice,stage,bot_im_id,work_order_id,idempotency_key,created_at',
    order: 'created_at.asc',
  };
  if (args.since) params.created_at = `gte.${toIso(args.since, false)}`;
  if (args.until) {
    // PostgREST only accepts a key once in URLSearchParams. Use and= for combined created_at filters.
    const filters = [];
    if (args.since) filters.push(`created_at.gte.${toIso(args.since, false)}`);
    filters.push(`created_at.lt.${toIso(args.until, true)}`);
    delete params.created_at;
    params.and = `(${filters.join(',')})`;
  }
  if (Number.isFinite(args.limit) && args.limit > 0) params.limit = String(args.limit);
  return params;
}

function toIso(value, endExclusive) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000+08:00`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function loadChatMessages(config, chatIds) {
  const messages = [];
  for (const batch of chunks(chatIds, 80)) {
    if (batch.length === 0) continue;
    const quoted = batch.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',');
    const rows = await supabaseAll(config, 'chat_messages', {
      select: 'chat_id,message_id,role,content,timestamp,candidate_name,manager_name',
      chat_id: `in.(${quoted})`,
      order: 'chat_id.asc,timestamp.asc',
    });
    messages.push(...rows);
  }

  const grouped = new Map();
  for (const message of messages) {
    if (!grouped.has(message.chat_id)) grouped.set(message.chat_id, []);
    grouped.get(message.chat_id).push(message);
  }
  return grouped;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatChat(messages) {
  return messages
    .map((message) => {
      const speaker = message.role === 'user' ? '候选人' : '招募经理';
      return `[${formatTime(message.timestamp)} ${speaker}] ${message.content || ''}`;
    })
    .join('\n\n');
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function buildFields(event, messages) {
  const userMessages = messages.filter((message) => message.role === 'user');
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];
  const fullChat = formatChat(messages);
  const recentChat = formatChat(messages.slice(-10));
  const currentMessage =
    lastMessage?.role === 'user' ? lastMessage.content : userMessages.at(-1)?.content || '';
  const candidateName =
    userMessages.find((message) => message.candidate_name)?.candidate_name || '';
  const managerName = messages.find((message) => message.manager_name)?.manager_name || '';
  const reasonLabel = REASON_LABELS[event.reason_code] || event.reason_code || '未分类';

  const fields = {
    [PRIMARY_EVENT_ID_FIELD]: event.idempotency_key,
    触发时间: new Date(event.created_at).getTime(),
    原因代码: event.reason_code,
    原因分类: reasonLabel,
    命中原因: truncate(event.reason || '', 3000),
    建议动作: truncate(event.action_advice || '', 2000),
    阶段: event.stage || '',
    会话ID: event.chat_id,
    候选人ID: event.user_id || '',
    候选人微信昵称: candidateName,
    招募经理姓名: managerName,
    托管账号ID: event.bot_im_id || '',
    工单ID: event.work_order_id == null ? undefined : Number(event.work_order_id),
    当前消息: truncate(currentMessage, 1000),
    最近10条聊天: truncate(recentChat, 5000),
    完整聊天记录: truncate(fullChat, 20000),
    聊天消息数: messages.length,
    首次聊天时间: firstMessage ? new Date(firstMessage.timestamp).getTime() : undefined,
    最近聊天时间: lastMessage ? new Date(lastMessage.timestamp).getTime() : undefined,
  };
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined || fields[key] === '') delete fields[key];
  }
  return fields;
}

async function listFields(token, appToken, tableId) {
  const data = await feishu(
    token,
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`,
  );
  return data.items || [];
}

async function renameField(token, appToken, tableId, field, newName) {
  return feishu(
    token,
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${field.field_id}`,
    {
      method: 'PUT',
      body: JSON.stringify({ field_name: newName, type: field.type }),
    },
  );
}

async function ensurePrimaryEventIdField(token, appToken, tableId) {
  let fields = await listFields(token, appToken, tableId);
  const names = new Set(fields.map((field) => field.field_name));
  if (names.has(PRIMARY_EVENT_ID_FIELD)) return fields;

  const defaultPrimaryField = fields.find(
    (field) =>
      DEFAULT_PRIMARY_FIELD_NAMES.includes(field.field_name) && field.type === FIELD_TYPES.TEXT,
  );

  if (defaultPrimaryField) {
    await renameField(token, appToken, tableId, defaultPrimaryField, PRIMARY_EVENT_ID_FIELD);
    fields = await listFields(token, appToken, tableId);
  }

  return fields;
}

async function ensureFields(token, appToken, tableId) {
  let fields = await ensurePrimaryEventIdField(token, appToken, tableId);
  const names = new Set(fields.map((field) => field.field_name));

  for (const spec of SCHEMA) {
    if (names.has(spec.name)) continue;
    const body = { field_name: spec.name, type: spec.type };
    if (spec.type === FIELD_TYPES.SINGLE_SELECT && spec.options?.length) {
      body.property = { options: spec.options.map((name) => ({ name })) };
    }
    await feishu(token, `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    fields = await listFields(token, appToken, tableId);
    names.clear();
    fields.forEach((field) => names.add(field.field_name));
  }

  return fields;
}

function normalizeField(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => item?.text ?? item?.name ?? String(item)).join('');
  }
  return value.text ?? value.name ?? String(value);
}

async function listAllRecords(token, appToken, tableId) {
  const records = [];
  let pageToken;
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    );
    url.searchParams.set('page_size', '500');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (body.code !== 0) throw new Error(`list records failed: ${body.code} ${body.msg}`);
    records.push(...(body.data?.items || []));
    pageToken = body.data?.has_more ? body.data.page_token : undefined;
  } while (pageToken);
  return records;
}

async function upsertRecords(token, appToken, tableId, rows) {
  const existing = await listAllRecords(token, appToken, tableId);
  const byEventId = new Map();
  for (const record of existing) {
    const eventId = EVENT_ID_LOOKUP_FIELDS.map((name) => normalizeField(record.fields?.[name])).find(
      Boolean,
    );
    if (eventId) byEventId.set(eventId, record.record_id);
  }

  const creates = [];
  const updates = [];
  for (const fields of rows) {
    const eventId = fields[PRIMARY_EVENT_ID_FIELD] || fields[LEGACY_EVENT_ID_FIELD];
    const recordId = byEventId.get(eventId);
    if (recordId) updates.push({ record_id: recordId, fields });
    else creates.push({ fields });
  }

  let created = 0;
  let updated = 0;

  for (const batch of chunks(creates, 100)) {
    if (batch.length === 0) continue;
    await feishu(token, `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
      method: 'POST',
      body: JSON.stringify({ records: batch }),
    });
    created += batch.length;
  }

  for (const batch of chunks(updates, 500)) {
    if (batch.length === 0) continue;
    await feishu(token, `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`, {
      method: 'POST',
      body: JSON.stringify({ records: batch }),
    });
    updated += batch.length;
  }

  return { created, updated, existing: existing.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...loadEnv(args.envPath), ...process.env };
  const config = requireConfig(env, args);

  const events = await supabaseAll(config, 'handoff_events', buildHandoffParams(args));
  const chatIds = [...new Set(events.map((event) => event.chat_id).filter(Boolean))];
  const messagesByChat = await loadChatMessages(config, chatIds);
  const rows = events.map((event) => buildFields(event, messagesByChat.get(event.chat_id) || []));

  const summary = {
    dryRun: args.dryRun,
    target: args.dryRun ? null : { appToken: config.appToken, tableId: config.tableId },
    events: events.length,
    chatIds: chatIds.length,
    rows: rows.length,
    firstEventAt: events[0]?.created_at || null,
    lastEventAt: events.at(-1)?.created_at || null,
    sample: rows.slice(0, 3).map((row) => ({
      事件ID: row[PRIMARY_EVENT_ID_FIELD] || row[LEGACY_EVENT_ID_FIELD],
      触发时间: row.触发时间 ? new Date(row.触发时间).toISOString() : null,
      原因代码: row.原因代码,
      原因分类: row.原因分类,
      会话ID: row.会话ID,
      聊天消息数: row.聊天消息数,
    })),
  };

  if (args.dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const token = await getTenantToken(config);
  const resolvedConfig = await resolveTargetFromWiki(token, config);
  await ensureFields(token, resolvedConfig.appToken, resolvedConfig.tableId);
  const result = await upsertRecords(token, resolvedConfig.appToken, resolvedConfig.tableId, rows);
  console.log(
    JSON.stringify(
      {
        ...summary,
        target: { appToken: resolvedConfig.appToken, tableId: resolvedConfig.tableId },
        ...result,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
