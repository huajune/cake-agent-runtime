#!/usr/bin/env node

/**
 * 用「手机号 + 面试时间」回查海绵工单，补记历史 interview.passed。
 *
 * 背景：历史 bug 导致 recruitment_cases.booking_id（海绵 workOrderId）全部为 NULL，
 * 于是 15min 轮询 cron（findWorkOrdersPendingPass 要求 booking.succeeded 带 work_order_id）
 * 永远扫不到这些预约 → 面试通过被严重少计（页面只剩 7）。
 *
 * 本脚本绕过丢失的 booking_id：
 *   recruitment_cases（报名人）
 *     → agent_long_term_memories.profile_facts.phone（取手机号）
 *     → 海绵 signup/list 按 phone 拉该候选人全部工单
 *     → 用 interviewTime 跟 recruitment_cases.interview_time 比对挑出对应工单
 *     → 工单有 interviewPassTime ⇒ 补记 interview.passed（幂等键 workOrderId:pass）
 *
 * 安全：默认 dry-run + 默认 .env.local。只有显式 `--apply` 才写库，
 *       只有显式 `--env .env.production` 才连生产。写入走与线上同一个幂等 RPC upsert_ops_event。
 *
 * 用法：
 *   # 只读：对生产源数据看真实能恢复多少（推荐先跑）
 *   node scripts/backfill-interview-passed-from-sponge.js --env .env.production --limit 10
 *   node scripts/backfill-interview-passed-from-sponge.js --env .env.production
 *   # 写入测试 prod-sync 库
 *   node scripts/backfill-interview-passed-from-sponge.js --env .env.local --apply
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_SPONGE_API_BASE_URL = 'https://gateway.duliday.com/sponge';
const SPONGE_TOKEN_CONFIG_KEY = 'sponge_token_config';
const PHONE_RE = /^1[3-9]\d{9}$/;

function parseArgs(argv) {
  const args = {
    env: '.env.local',
    dryRun: true,
    limit: null,
    concurrency: 4,
    corpId: null,
    userId: null,
    phoneMapFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--env' && value) ((args.env = value), (i += 1));
    else if (key === '--limit' && value) ((args.limit = Number(value)), (i += 1));
    else if (key === '--concurrency' && value) ((args.concurrency = Number(value)), (i += 1));
    else if (key === '--corp-id' && value) ((args.corpId = value), (i += 1));
    else if (key === '--user-id' && value) ((args.userId = value), (i += 1));
    else if (key === '--phone-map' && value) ((args.phoneMapFile = value), (i += 1));
    else if (key === '--out' && value) ((args.outFile = value), (i += 1));
    else if (key === '--target-env' && value) ((args.targetEnv = value), (i += 1));
    else if (key === '--apply') args.dryRun = false;
    else if (key === '--dry-run') args.dryRun = true;
  }
  return args;
}

function loadEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`env 文件不存在: ${absolute}`);
  for (const line of fs.readFileSync(absolute, 'utf8').split(/\r?\n/)) {
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
  if (!value) throw new Error(`缺少环境变量 ${name}${fallbackName ? ` 或 ${fallbackName}` : ''}`);
  return value;
}

/** 解析 env 文件为对象（不写 process.env），供分离 target 库用——两个 env 文件变量名相同。 */
function parseEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`env 文件不存在: ${absolute}`);
  const out = {};
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
    out[m[1]] = value;
  }
  return out;
}

/** 从 target ledger 拉 booking.succeeded 映射：user_id → [{ corpId, workOrderId(合成), botImId, chatId, brand, store }]。 */
async function loadBookingMap(targetClient) {
  const map = new Map();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await targetClient
      .from('ops_events')
      .select('corp_id, user_id, chat_id, bot_im_id, payload')
      .eq('event_name', 'booking.succeeded')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (!row.user_id) continue;
      const woId = row.payload?.work_order_id ?? row.payload?.workOrderId;
      if (!woId) continue;
      const arr = map.get(row.user_id) || [];
      arr.push({
        corpId: row.corp_id,
        workOrderId: String(woId),
        botImId: row.bot_im_id ?? null,
        chatId: row.chat_id ?? null,
        brand: row.payload?.brand_name ?? null,
        store: row.payload?.store_name ?? null,
      });
      map.set(row.user_id, arr);
    }
    if (data.length < pageSize) break;
  }
  return map;
}

function maskPhone(phone) {
  return phone ? `${phone.slice(0, 3)}****${phone.slice(-2)}` : '';
}

/** 海绵时间 "YYYY-MM-DD HH:mm:ss"（中国本地、无时区）→ 带 +08:00 的 ISO，保证 RPC 按 Asia/Shanghai 落对 report_date。 */
function cnLocalToIso(value) {
  if (!value) return null;
  const m = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}+08:00`;
}

/** 取「日」用于 interviewTime 粗匹配。 */
function dayKey(value) {
  const m = String(value ?? '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---------------------------------------------------------------------------
// 海绵 token 解析（精简复刻 SpongeService.resolveConfiguredDulidayToken）
// ---------------------------------------------------------------------------
function resolveTokenValue(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (v.token && v.token.trim()) return v.token.trim();
  if (v.tokenEnv && process.env[v.tokenEnv]) return process.env[v.tokenEnv].trim();
  return null;
}

function buildTokenResolver(config, fallbackToken) {
  const accounts = Array.isArray(config?.accounts) ? config.accounts : [];
  return function resolve(botImId) {
    const id = (botImId ?? '').trim();
    if (id) {
      const acc = accounts.find((a) => a && a.enabled !== false && (a.botImId ?? '').trim() === id);
      const fromAcc = resolveTokenValue(acc);
      if (fromAcc) return fromAcc;
      const fromMap = resolveTokenValue(config?.byBotImId?.[id]);
      if (fromMap) return fromMap;
    }
    const fromDefault = resolveTokenValue({
      token: config?.defaultToken,
      tokenEnv: config?.defaultTokenEnv,
    });
    return fromDefault ?? fallbackToken ?? null;
  };
}

async function loadSpongeTokenConfig(client) {
  const { data, error } = await client
    .from('system_config')
    .select('value')
    .eq('key', SPONGE_TOKEN_CONFIG_KEY)
    .maybeSingle();
  if (error) {
    console.warn(`读取 sponge_token_config 失败，回退 DULIDAY_API_TOKEN: ${error.message}`);
    return null;
  }
  const raw = data?.value;
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ---------------------------------------------------------------------------
// 海绵 signup/list 按手机号查工单
// ---------------------------------------------------------------------------
async function fetchWorkOrdersByPhone(signupListApi, token, phone) {
  const resp = await fetch(signupListApi, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Duliday-Token': token },
    body: JSON.stringify({ phone }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const json = await resp.json();
  if (json?.code !== 0) throw new Error(`业务失败: ${json?.message ?? '未知'}`);
  const data = json?.data ?? {};
  const workOrders = Array.isArray(data.workOrders) ? data.workOrders : [];
  return workOrders.map((w) => ({
    workOrderId: Number(w.workOrderId),
    interviewTime: w.interviewTime ?? null,
    interviewPassTime: w.interviewPassTime ?? null,
    currentStatus: w.currentStatus ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 读取报名人（按 user 聚合）+ 手机号
// ---------------------------------------------------------------------------
async function fetchBookings(client, { corpId, userId, limit }) {
  let query = client
    .from('recruitment_cases')
    .select(
      'corp_id, user_id, chat_id, bot_im_id, status, booked_at, interview_time, brand_name, store_name, job_name',
    )
    .order('booked_at', { ascending: false });
  if (corpId) query = query.eq('corp_id', corpId);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw error;

  // 按 (corp_id, user_id) 聚合：每人取最近一条做主记录，同时保留全部 interview_time 备匹配。
  const byUser = new Map();
  for (const row of data ?? []) {
    if (!row.user_id) continue;
    const key = `${row.corp_id}::${row.user_id}`;
    if (!byUser.has(key)) {
      byUser.set(key, { ...row, interviewDays: new Set() });
    }
    const d = dayKey(row.interview_time) || dayKey(row.booked_at);
    if (d) byUser.get(key).interviewDays.add(d);
  }
  let users = [...byUser.values()];
  if (Number.isFinite(limit) && limit) users = users.slice(0, limit);
  return users;
}

/**
 * 从外部 JSON 文件加载手机号映射（多源已在 SQL 端按可信度合并：画像 / 报名工具入参 / 候选人自发）。
 * 文件格式：[{ corp_id, user_id, phone, source }]
 */
function loadPhoneMapFile(filePath) {
  const arr = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  const map = new Map();
  const sources = {};
  for (const r of arr) {
    const phone = String(r.phone ?? '').trim();
    if (!PHONE_RE.test(phone)) continue;
    map.set(`${r.corp_id}::${r.user_id}`, phone);
    sources[r.source || 'unknown'] = (sources[r.source || 'unknown'] || 0) + 1;
  }
  console.log(`手机号映射(文件): ${map.size} 条; 来源 ${JSON.stringify(sources)}`);
  return map;
}

async function loadPhoneMap(client) {
  const map = new Map();
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from('agent_long_term_memories')
      .select('corp_id, user_id, profile_facts')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const phone = row?.profile_facts?.phone?.value;
      if (phone && PHONE_RE.test(String(phone).trim())) {
        map.set(`${row.corp_id}::${row.user_id}`, String(phone).trim());
      }
    }
    if (data.length < pageSize) break;
  }
  return map;
}

// 简单并发池
async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < items.length) {
      const myIdx = idx++;
      results[myIdx] = await worker(items[myIdx], myIdx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.env);

  const url = requireEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const fallbackToken = (process.env.DULIDAY_API_TOKEN || '').trim() || null;
  const spongeBaseUrl = (process.env.SPONGE_API_BASE_URL || DEFAULT_SPONGE_API_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const signupListApi = `${spongeBaseUrl}/ai/api/workorder/signup/list`;

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // target 库：写入目标（默认同源库）。读源用 client，写库用 targetClient。
  let targetClient = client;
  let targetUrl = url;
  if (args.targetEnv) {
    const tEnv = parseEnvFile(args.targetEnv);
    targetUrl = tEnv.SUPABASE_URL || tEnv.NEXT_PUBLIC_SUPABASE_URL;
    const tKey = tEnv.SUPABASE_SERVICE_ROLE_KEY;
    if (!targetUrl || !tKey)
      throw new Error(`target env 缺少 URL / SERVICE_ROLE_KEY: ${args.targetEnv}`);
    targetClient = createClient(targetUrl, tKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  console.log(`\n=== interview.passed 回填（海绵手机号回查）===`);
  console.log(`模式: ${args.dryRun ? 'DRY-RUN（只读，不写库）' : '⚠️ APPLY（写库）'}`);
  console.log(`源库: ${url}`);
  console.log(`写库: ${targetUrl}`);
  console.log(`海绵: ${signupListApi}`);
  if (args.limit) console.log(`限制: 前 ${args.limit} 人`);

  const tokenConfig = await loadSpongeTokenConfig(client);
  const resolveToken = buildTokenResolver(tokenConfig, fallbackToken);

  const [bookings, phoneMap] = await Promise.all([
    fetchBookings(client, { corpId: args.corpId, userId: args.userId, limit: args.limit }),
    args.phoneMapFile ? Promise.resolve(loadPhoneMapFile(args.phoneMapFile)) : loadPhoneMap(client),
  ]);

  const stats = {
    bookingUsers: bookings.length,
    withPhone: 0,
    spongeQueried: 0,
    spongeError: 0,
    spongeHasWorkOrder: 0,
    passedUsers: 0,
    passedWorkOrders: 0,
    multiWorkOrder: 0,
    matchedByDay: 0,
    inserted: 0,
    insertSkippedOrDup: 0,
  };
  const recovered = []; // { corpId, userId, chatId, botImId, workOrderId, interviewPassTime, currentStatus, matched }

  await mapWithConcurrency(bookings, args.concurrency, async (b) => {
    const phone = phoneMap.get(`${b.corp_id}::${b.user_id}`);
    if (!phone) return;
    stats.withPhone += 1;

    const token = resolveToken(b.bot_im_id);
    if (!token) {
      stats.spongeError += 1;
      return;
    }

    let workOrders;
    try {
      stats.spongeQueried += 1;
      workOrders = await fetchWorkOrdersByPhone(signupListApi, token, phone);
    } catch (e) {
      stats.spongeError += 1;
      return;
    }
    if (workOrders.length === 0) return;
    stats.spongeHasWorkOrder += 1;
    if (workOrders.length > 1) stats.multiWorkOrder += 1;

    const passed = workOrders.filter(
      (w) => Number.isFinite(w.workOrderId) && w.workOrderId > 0 && w.interviewPassTime,
    );
    if (passed.length === 0) return;

    // 多工单时优先挑 interviewTime 落在该报名人某个面试日的工单；挑不到就全收（按工单各记一条）。
    let chosen = passed;
    if (passed.length > 1 && b.interviewDays.size > 0) {
      const matched = passed.filter((w) => {
        const d = dayKey(w.interviewTime);
        return d && b.interviewDays.has(d);
      });
      if (matched.length > 0) {
        chosen = matched;
        stats.matchedByDay += 1;
      }
    }

    stats.passedUsers += 1;
    for (const w of chosen) {
      stats.passedWorkOrders += 1;
      recovered.push({
        corpId: b.corp_id,
        userId: b.user_id,
        chatId: b.chat_id,
        botImId: b.bot_im_id,
        workOrderId: w.workOrderId,
        interviewPassTime: w.interviewPassTime,
        currentStatus: w.currentStatus,
        phoneMasked: maskPhone(phone),
        store: b.store_name,
        brand: b.brand_name,
      });
    }
  });

  // 规划写入：每条通过匹配到该用户的 booking 事件，复用其合成 workOrderId（让 KPI 与 cohort 漏斗都连上）。
  // 始终先把计划算出来（只读 target ledger）；dry-run 仅产出计划清单，apply 才真正写。
  stats.insertFailed = 0;
  const plan = [];
  const planStats = { matched: 0, kpiOnlyNoBooking: 0, kpiOnlyDup: 0, existingDup: 0 };
  if (args.targetEnv || !args.dryRun) {
    const TARGET_CORP = 'prod-sync'; // ledger 统一 corp
    const bookingMap = await loadBookingMap(targetClient);

    // 预占已有 interview.passed：既避免同人二次通过把 KPI 去重折叠，也用于估算"新增"数。
    const usedSyntheticWo = new Set();
    const existingKeys = new Set();
    {
      const { data: existing } = await targetClient
        .from('ops_events')
        .select('idempotency_key, payload')
        .eq('event_name', 'interview.passed');
      for (const row of existing || []) {
        const wo = row.payload?.work_order_id ?? row.payload?.workOrderId;
        if (wo) usedSyntheticWo.add(String(wo));
        if (row.idempotency_key) existingKeys.add(row.idempotency_key);
      }
    }

    // 同一 realWorkOrderId 只写一次
    const seenReal = new Set();
    const uniq = recovered.filter((r) => {
      const k = String(r.workOrderId);
      if (seenReal.has(k)) return false;
      seenReal.add(k);
      return true;
    });

    for (const r of uniq) {
      const occurredAtIso = cnLocalToIso(r.interviewPassTime) ?? new Date().toISOString();
      const candidates = bookingMap.get(r.userId) || [];
      let booking = null;
      if (candidates.length === 1) booking = candidates[0];
      else if (candidates.length > 1) {
        booking =
          candidates.find((c) => c.store && r.store && c.store === r.store) ||
          candidates.find((c) => c.brand && r.brand && c.brand === r.brand) ||
          candidates.find((c) => !usedSyntheticWo.has(c.workOrderId)) ||
          candidates[0];
      }

      let cohortWo, matchedBy, corpId, botImId, chatId;
      if (booking && !usedSyntheticWo.has(booking.workOrderId)) {
        usedSyntheticWo.add(booking.workOrderId);
        cohortWo = booking.workOrderId;
        matchedBy = 'sponge_phone_backfill';
        corpId = booking.corpId || TARGET_CORP;
        botImId = booking.botImId ?? r.botImId ?? null;
        chatId = booking.chatId ?? r.chatId ?? null;
        planStats.matched += 1;
      } else {
        cohortWo = String(r.workOrderId);
        matchedBy = booking ? 'kpi_only_dup' : 'kpi_only_no_booking';
        corpId = TARGET_CORP;
        botImId = r.botImId ?? null;
        chatId = r.chatId ?? null;
        if (booking) planStats.kpiOnlyDup += 1;
        else planStats.kpiOnlyNoBooking += 1;
      }

      const idempotencyKey = `${r.workOrderId}:pass`;
      const isExisting = existingKeys.has(idempotencyKey);
      if (isExisting) planStats.existingDup += 1;

      plan.push({
        idempotencyKey,
        isExisting,
        matchedBy,
        store: r.store,
        brand: r.brand,
        rpcArgs: {
          p_corp_id: corpId,
          p_event_name: 'interview.passed',
          p_idempotency_key: idempotencyKey,
          p_occurred_at: occurredAtIso,
          p_bot_im_id: botImId,
          p_manager_name: null,
          p_group_name: null,
          p_source_channel: null,
          p_user_id: r.userId ?? null,
          p_chat_id: chatId,
          p_payload: {
            work_order_id: cohortWo,
            workOrderId: cohortWo,
            original_work_order_id: r.workOrderId,
            current_status: r.currentStatus ?? null,
            matched_by: matchedBy,
            backfill: 'sponge-phone',
          },
        },
      });
    }

    if (!args.dryRun) {
      for (const p of plan) {
        const { data, error } = await targetClient.rpc('upsert_ops_event', p.rpcArgs);
        if (error) {
          stats.insertFailed += 1;
          console.warn(`写入失败 key=${p.idempotencyKey}: ${error.message}`);
        } else if (data?.inserted === true) {
          stats.inserted += 1;
        } else {
          stats.insertSkippedOrDup += 1;
        }
      }
    }
  }

  // 报告
  console.log(`\n--- 覆盖率报告 ---`);
  console.log(`报名人(去重):        ${stats.bookingUsers}`);
  console.log(`有有效手机号:        ${stats.withPhone}`);
  console.log(`查海绵成功(发起):    ${stats.spongeQueried}（失败/无token: ${stats.spongeError}）`);
  console.log(
    `海绵返回有工单:      ${stats.spongeHasWorkOrder}（其中多工单: ${stats.multiWorkOrder}，按日匹配命中: ${stats.matchedByDay}）`,
  );
  console.log(`面试已通过(人):      ${stats.passedUsers}`);
  console.log(`面试已通过(工单数):  ${stats.passedWorkOrders}  ← 这才是真实"面试通过"`);

  if (plan.length > 0) {
    const newRows = plan.filter((p) => !p.isExisting).length;
    console.log(`\n--- 写入计划（target ledger）---`);
    console.log(`计划事件总数:        ${plan.length}`);
    console.log(`  其中已存在(幂等跳过): ${planStats.existingDup}`);
    console.log(`  预计新增:            ${newRows}`);
    console.log(`匹配到 booking(进 cohort 漏斗): ${planStats.matched}`);
    console.log(`仅计入 KPI(无 booking):        ${planStats.kpiOnlyNoBooking}`);
    console.log(`仅计入 KPI(同人重复占用):      ${planStats.kpiOnlyDup}`);
    console.log(
      `预估写入后·面试通过 KPI ≈ ${plan.length}（全量），可匹配通过 ≈ ${planStats.matched}`,
    );
  }

  if (!args.dryRun) {
    console.log(
      `\n实际写入:            ${stats.inserted}（幂等跳过: ${stats.insertSkippedOrDup}，失败: ${stats.insertFailed}）`,
    );
  }

  if (args.outFile) {
    fs.writeFileSync(path.resolve(args.outFile), JSON.stringify(recovered, null, 2));
    console.log(`恢复清单已写入: ${args.outFile}（${recovered.length} 条）`);
  }
  if (plan.length > 0) {
    fs.writeFileSync('/tmp/backfill-plan.json', JSON.stringify(plan, null, 2));
    console.log(`写入计划已落盘: /tmp/backfill-plan.json（${plan.length} 条 RPC 入参）`);
  }

  const sample = recovered.slice(0, 20);
  if (sample.length > 0) {
    console.log(`\n--- 恢复样例（前 ${sample.length} 条）---`);
    for (const r of sample) {
      console.log(
        `  wo=${r.workOrderId}  pass=${r.interviewPassTime}  status=${r.currentStatus ?? '-'}  phone=${r.phoneMasked}  ${r.brand ?? ''}/${r.store ?? ''}`,
      );
    }
  }
  console.log(
    args.dryRun
      ? `\n这是 dry-run，没有写库。确认数字后用 --apply 写入（注意 --env 选对库）。\n`
      : `\n写入完成。\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败:', err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  maskPhone,
  cnLocalToIso,
  dayKey,
  resolveTokenValue,
  buildTokenResolver,
};
