/**
 * 一次性回灌：补 2026-06-05 ops_events 写入断档窗口的缺失事件。
 *
 * 背景：v5.12.0（含 ops_events 写入）约北京 16:11 才上生产，且当天 02:10:08–08:11:29 UTC
 * （北京 10:10–16:11）ops_events 整段没写入。期间 message_processing_records 正常记录，
 * 故从它重建该窗口的运营事件，经 upsert_ops_event RPC 回灌（写底账 + 投影 daily_ops_report + 幂等）。
 *
 * 安全：
 *  - 默认 dry-run，只读 + 打印将补的事件计数；只有显式 `--apply` 才写库。
 *  - 显式连 .env.production，并硬断言 URL 指向生产 ref，避免灌错库。
 *  - 只处理断档窗口内的轮次；once-per 事件用 live 的确切幂等键，由 RPC 幂等去重，
 *    且按"该 user/chat 首次出现是否落在窗口内"门控，避免把老候选人误计入今天。
 *
 * 用法：
 *   node scripts/backfill-ops-events-gap-20260605.js            # dry-run
 *   node scripts/backfill-ops-events-gap-20260605.js --apply    # 写生产
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');
const PROD_REF = 'uvmbxcilpteaiizplcyp';
const GAP_START = '2026-06-05T02:10:08.087Z';
const GAP_END = '2026-06-05T08:11:29.095Z';
const REPORT_DATE = '2026-06-05';
const CORP_ID = '68d368d1fa2192479454c295'; // 生产真实 orgId（非 'default'，否则 corp 维度对不上 dashboard）
const SOURCE_CHANNEL = 'unknown';

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(path.join(process.cwd(), file), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function inGap(iso) {
  return iso > GAP_START && iso < GAP_END;
}

async function main() {
  const env = loadEnv('.env.production');
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('缺少 .env.production 的 URL / SERVICE_ROLE_KEY');
  if (!url.includes(PROD_REF)) throw new Error(`安全中止：URL 非生产 ref（${url}）`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  console.log(`[backfill] 目标=生产(${PROD_REF}) 模式=${APPLY ? 'APPLY(写库)' : 'DRY-RUN'} 窗口=${GAP_START}~${GAP_END}`);

  // 1) manager_name -> bot_im_id 映射（取近 7 天 ops_events 里 bot_im_id 非空、按最近一次出现取值，含同名换 wxid 取最新）
  const { data: mapRows, error: mapErr } = await db
    .from('ops_events')
    .select('manager_name, bot_im_id, occurred_at')
    .not('bot_im_id', 'is', null)
    .gte('report_date', '2026-05-29');
  if (mapErr) throw mapErr;
  const botByManager = new Map();
  const seenAt = new Map();
  for (const r of mapRows ?? []) {
    if (!r.manager_name) continue;
    if (!seenAt.has(r.manager_name) || r.occurred_at > seenAt.get(r.manager_name)) {
      botByManager.set(r.manager_name, r.bot_im_id);
      seenAt.set(r.manager_name, r.occurred_at);
    }
  }
  console.log(`[backfill] manager→bot 映射条数: ${botByManager.size}`);

  // 2) 拉断档窗口内的轮次
  const { data: turns, error: turnErr } = await db
    .from('message_processing_records')
    .select('id, message_id, chat_id, user_id, manager_name, received_at, status, reply_preview, tool_calls, is_synthetic')
    .gt('received_at', GAP_START)
    .lt('received_at', GAP_END)
    .order('received_at', { ascending: true });
  if (turnErr) throw turnErr;
  console.log(`[backfill] 窗口内轮次: ${turns?.length ?? 0}`);

  // 3) once-per 门控：该 user/chat 全历史首次出现是否在窗口内
  const userIds = [...new Set((turns ?? []).map((t) => t.user_id).filter(Boolean))];
  const chatIds = [...new Set((turns ?? []).map((t) => t.chat_id).filter(Boolean))];
  const firstSeen = async (col, ids) => {
    const m = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data } = await db
        .from('message_processing_records')
        .select(`${col}, received_at`)
        .in(col, chunk)
        .order('received_at', { ascending: true });
      for (const r of data ?? []) if (!m.has(r[col])) m.set(r[col], r.received_at);
    }
    return m;
  };
  const userFirst = await firstSeen('user_id', userIds);
  const chatFirst = await firstSeen('chat_id', chatIds);

  // 4) 重建事件
  const events = [];
  const seenOnce = new Set();
  const botOf = (t) => t.bot_im_id || botByManager.get(t.manager_name) || null;
  const pushOnce = (keyDedup, ev) => {
    if (seenOnce.has(keyDedup)) return;
    seenOnce.add(keyDedup);
    events.push(ev);
  };

  for (const t of turns ?? []) {
    const base = {
      corpId: CORP_ID,
      botImId: botOf(t),
      managerName: t.manager_name ?? null,
      sourceChannel: SOURCE_CHANNEL,
      userId: t.user_id ?? null,
      chatId: t.chat_id ?? null,
      occurredAt: new Date(t.received_at).toISOString(),
    };

    // candidate.message_received（确切键=message_id）
    if (t.message_id && !t.is_synthetic) {
      events.push({ ...base, eventName: 'candidate.message_received', idempotencyKey: t.message_id });
    }
    // agent.replied（窗口内无重叠，用 id:replied）—— 有回复才记
    if (t.status === 'success' || (t.reply_preview && t.reply_preview.length > 0)) {
      events.push({ ...base, eventName: 'agent.replied', idempotencyKey: `${t.id}:replied` });
    }
    // once-per：仅当该 user/chat 首次出现就在窗口内
    if (t.user_id && inGap(userFirst.get(t.user_id) ?? '')) {
      pushOnce(`fr:${t.user_id}`, { ...base, eventName: 'friend.added', idempotencyKey: `${t.user_id}:friend_added` });
    }
    if (t.chat_id && inGap(chatFirst.get(t.chat_id) ?? '')) {
      pushOnce(`en:${t.chat_id}`, { ...base, eventName: 'candidate.engaged', idempotencyKey: `${t.chat_id}:engaged` });
      pushOnce(`op:${t.chat_id}`, { ...base, eventName: 'agent.opening_sent', idempotencyKey: `${t.chat_id}:opening` });
    }

    // 工具事件
    const calls = Array.isArray(t.tool_calls) ? t.tool_calls : [];
    for (const c of calls) {
      const tool = c?.toolName;
      const res = c?.result ?? {};
      if (tool === 'duliday_interview_booking' && res.success === true) {
        const wo = res.workOrderId ?? res.work_order_id ?? res?.data?.workOrderId;
        const key = wo != null ? String(wo) : `${t.chat_id}:booking_success:${res?.job?.jobId ?? 'na'}:${res?.interviewTime ?? t.id}`;
        events.push({ ...base, eventName: 'booking.succeeded', idempotencyKey: key, payload: { work_order_id: wo ?? null, backfill: true } });
      } else if (tool === 'duliday_interview_booking' && res.success === false) {
        events.push({ ...base, eventName: 'booking.failed', idempotencyKey: `${t.chat_id}:booking_fail:${res?.job?.jobId ?? 'na'}:${t.id}`, payload: { backfill: true } });
      } else if (tool === 'duliday_interview_precheck' && res.nextAction === 'ready_to_book') {
        const jobId = res?.job?.jobId ?? res?.jobId ?? 'na';
        events.push({ ...base, eventName: 'precheck.passed', idempotencyKey: `${t.chat_id}:precheck:${jobId}:${t.id}`, payload: { job_id: jobId, backfill: true } });
      } else if (tool === 'duliday_job_list' && res.queryMeta != null) {
        events.push({ ...base, eventName: 'job.recommended', idempotencyKey: `${t.chat_id}:job_recommend:${t.id}`, payload: { backfill: true } });
      } else if (tool === 'invite_to_group' && res.success === true) {
        const g = res?.groupName ?? res?.group_name ?? 'na';
        events.push({ ...base, eventName: 'group.invited', idempotencyKey: `${t.chat_id}:group:${g}:${t.id}`, payload: { group_name: g, backfill: true } });
      } else if (tool === 'request_handoff') {
        events.push({ ...base, eventName: 'handoff.triggered', idempotencyKey: `${t.chat_id}:handoff:${t.id}`, payload: { backfill: true } });
      }
    }
  }

  // 5) 汇总
  const byType = {};
  let noBot = 0;
  for (const e of events) {
    byType[e.eventName] = (byType[e.eventName] || 0) + 1;
    if (!e.botImId) noBot += 1;
  }
  console.log('\n[backfill] 将回灌事件统计:');
  for (const k of Object.keys(byType).sort()) console.log(`  ${k}: ${byType[k]}`);
  console.log(`  合计: ${events.length}（其中无 bot_im_id: ${noBot}）`);

  if (!APPLY) {
    console.log('\n[backfill] DRY-RUN 结束，未写库。确认无误后加 --apply 写生产。');
    return;
  }

  // 6) 写库（逐条调 RPC，幂等）
  let inserted = 0, dup = 0, failed = 0;
  for (const e of events) {
    const { data, error } = await db.rpc('upsert_ops_event', {
      p_corp_id: e.corpId,
      p_event_name: e.eventName,
      p_idempotency_key: e.idempotencyKey,
      p_occurred_at: e.occurredAt,
      p_bot_im_id: e.botImId,
      p_manager_name: e.managerName,
      p_group_name: e.groupName ?? null,
      p_source_channel: e.sourceChannel ?? null,
      p_user_id: e.userId,
      p_chat_id: e.chatId,
      p_payload: e.payload ?? null,
    });
    if (error) { failed += 1; if (failed <= 5) console.warn('  写入失败:', e.eventName, error.message); continue; }
    if (data && (data.inserted === true || data?.[0]?.inserted === true)) inserted += 1; else dup += 1;
  }
  console.log(`\n[backfill] APPLY 完成: inserted=${inserted} duplicate=${dup} failed=${failed}`);
}

main().catch((e) => { console.error('[backfill] 失败:', e); process.exit(1); });
