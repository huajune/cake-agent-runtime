#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { createClient } = require('@supabase/supabase-js');

const FIELDS = [
  'botId',
  'imBotId',
  'imContactId',
  'contactType',
  'contactName',
  'externalUserId',
  'avatar',
];
const CONTACT_TYPES = { UNKNOWN: 0, PERSONAL_WECHAT: 1, OFFICIAL_ACCOUNT: 2, ENTERPRISE_WECHAT: 3 };
const hasValue = (value) =>
  value !== null && value !== undefined && !(typeof value === 'string' && !value.trim());

function sessionIds(row) {
  return [
    ...new Set(
      [
        ...Object.keys(row.consolidation_watermarks?.bySession ?? {}),
        ...(Array.isArray(row.episodic_session_summaries)
          ? row.episodic_session_summaries
          : []
        ).map((s) => s?.sessionId),
        ...Object.values(row.semantic_profile ?? {}).map((f) => f?.originSessionId),
        ...Object.values(row.semantic_job_intent ?? {}).map((f) => f?.originSessionId),
      ].filter((s) => typeof s === 'string' && s.trim()),
    ),
  ];
}

/** 只接受记忆自带血缘的会话、相同候选人和稳定 bot；旧行必须只有一个确定的 bot。 */
function buildPatch(row, messages) {
  const sessions = new Set(sessionIds(row));
  const existing = row.message_metadata;
  if (existing != null && (typeof existing !== 'object' || Array.isArray(existing))) return null;
  const matches = messages.filter(
    (m) =>
      sessions.has(m.chat_id) &&
      m.role === 'user' &&
      !m.is_self &&
      !m.is_room &&
      (m.im_contact_id === row.user_id || m.external_user_id === row.user_id) &&
      hasValue(m.manager_name) &&
      hasValue(m.im_bot_id) &&
      (!row.bot_user_id || m.manager_name === row.bot_user_id),
  );
  const bots = new Set(matches.map((m) => `${m.manager_name}\0${m.im_bot_id}`));
  if (bots.size !== 1) return null;
  matches.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  // 标识冲突不得拼出一个不存在的跨系统身份；已有外部标识与消息冲突也跳过。
  for (const [field, column] of [
    ['imBotId', 'im_bot_id'],
    ['imContactId', 'im_contact_id'],
    ['externalUserId', 'external_user_id'],
  ]) {
    const values = new Set(matches.map((m) => m[column]).filter(hasValue));
    if (
      values.size > 1 ||
      (hasValue(existing?.[field]) && values.size && !values.has(existing[field]))
    )
      return null;
  }
  const patch = {};
  for (const m of matches) {
    const candidate = {
      imBotId: m.im_bot_id,
      imContactId: m.im_contact_id,
      contactType:
        typeof m.contact_type === 'string' ? CONTACT_TYPES[m.contact_type] : m.contact_type,
      contactName: m.candidate_name,
      externalUserId: m.external_user_id,
      avatar: m.avatar,
    };
    for (const [key, value] of Object.entries(candidate)) {
      if (!hasValue(existing?.[key]) && !hasValue(patch[key]) && hasValue(value))
        patch[key] = value;
    }
  }
  // chat_messages 没有 bot_id；不能把 manager_name/wecomUserId 猜成 botId。
  return Object.keys(patch).length ? patch : null;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const apply = args.includes('--apply');
  const limit = Number(option('--limit', '40000'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 40000)
    throw new Error('limit must be 1..40000');
  const config = parseEnv(fs.readFileSync(path.resolve(option('--env', '.env.local')), 'utf8'));
  const client = createClient(
    config.SUPABASE_URL || config.NEXT_PUBLIC_SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false },
    },
  );
  const backup = option('--backup', null);
  if (apply && !backup) throw new Error('--apply requires --backup <new private JSONL path>');
  const fd = apply ? fs.openSync(path.resolve(backup), 'wx', 0o600) : null;
  const stats = { scanned: 0, recoverable: 0, updated: 0, concurrentSkipped: 0, unresolvable: 0 };
  let cursor = null;
  try {
    while (stats.scanned < limit) {
      let q = client
        .from('agent_long_term_memories')
        .select('*')
        .order('id')
        .limit(Math.min(100, limit - stats.scanned));
      if (cursor) q = q.gt('id', cursor);
      const { data: rows, error } = await q;
      if (error) throw error;
      if (!rows.length) break;
      for (const row of rows) {
        stats.scanned++;
        cursor = row.id;
        if (FIELDS.every((f) => hasValue(row.message_metadata?.[f]))) continue;
        const messages = [];
        for (const chatId of sessionIds(row)) {
          const { data, error: lookupError } = await client
            .from('chat_messages')
            .select(
              'id,chat_id,role,is_self,is_room,manager_name,im_bot_id,im_contact_id,external_user_id,contact_type,candidate_name,avatar,timestamp',
            )
            .eq('chat_id', chatId)
            .eq('role', 'user')
            .order('timestamp', { ascending: false })
            .limit(20);
          if (lookupError) throw lookupError;
          messages.push(...data);
        }
        const patch = buildPatch(row, messages);
        if (!patch) {
          stats.unresolvable++;
          continue;
        }
        stats.recoverable++;
        if (!apply) continue;
        fs.writeSync(
          fd,
          JSON.stringify({ before: row, patch, sourceMessageIds: messages.map((m) => m.id) }) +
            '\n',
        );
        fs.fsyncSync(fd);
        let update = client
          .from('agent_long_term_memories')
          .update({ message_metadata: { ...row.message_metadata, ...patch } })
          .eq('id', row.id)
          .eq('updated_at', row.updated_at);
        update =
          row.message_metadata == null
            ? update.is('message_metadata', null)
            : update.eq('message_metadata', JSON.stringify(row.message_metadata));
        const { data: written, error: writeError } = await update.select('id');
        if (writeError) throw writeError;
        if (written.length) stats.updated++;
        else stats.concurrentSkipped++;
      }
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  console.log(JSON.stringify(stats));
}

module.exports = { buildPatch, sessionIds };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
