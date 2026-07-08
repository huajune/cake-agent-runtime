#!/usr/bin/env node

/**
 * 回填「运营日报」飞书多维表格里缺失的「今日报名成功数」/「今日面试通过数」。
 *
 * 背景：ops-daily-report cron（每天 21:00）从 2026-07-02/07-05 起才稳定写这两列；
 * 更早的 06-10 ~ 07-01 行虽然存在，但两列为空。本脚本按 cron 的**同一口径**补齐：
 *   - 每个 bot 的报名/通过数 = 海绵 signup/self/list 用 Duliday-Token 按时间段查（权威口径，
 *     与 07-05/07-06 已填行一致；daily_ops_report 的投影数严重少计，不能用）。
 *   - 拿不到 token 的账号（晓阳测试组等）回退 daily_ops_report 投影数（与 cron 的
 *     fallbackToProjectedMetrics 一致）。
 *
 * 匹配：飞书行(date, 招募经理) → daily_ops_report(date, manager_name) → bot_im_id(wxid)
 *       → hosting_member_config[wxid].dulidayToken。
 *
 * 安全：默认 dry-run + 默认 .env.production（本表只有生产）；只有 --apply 才写飞书。
 *       只填**空**单元格，绝不覆盖已有值。
 *
 * 用法：
 *   node scripts/backfill-ops-report-feishu-counts.js               # dry-run，打印将写入的值
 *   node scripts/backfill-ops-report-feishu-counts.js --apply       # 真正写入飞书
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_SPONGE_API_BASE_URL = 'https://gateway.duliday.com/sponge';
const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const SYNC_BOT_PREFIX = 'prod-sync:';
const HOSTING_MEMBER_CONFIG_KEY = 'hosting_member_config';

function parseArgs(argv) {
  const args = { env: '.env.production', apply: false, concurrency: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--env' && v) ((args.env = v), (i += 1));
    else if (k === '--concurrency' && v) ((args.concurrency = Number(v)), (i += 1));
    else if (k === '--apply') args.apply = true;
    else if (k === '--dry-run') args.apply = false;
  }
  return args;
}

function parseEnvFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`env 文件不存在: ${abs}`);
  const out = {};
  for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}

function normalizeBotImId(botImId) {
  const t = String(botImId || '').trim();
  return t.startsWith(SYNC_BOT_PREFIX) ? t.slice(SYNC_BOT_PREFIX.length).trim() : t;
}

// 飞书 DATETIME 字段存的是「上海午夜」对应的 UTC 毫秒（cron 用 parseLocalDateStart 写入）。
// 直接按 UTC 取日期会早一天，故 +8h 还原上海日历日期。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const fmtDate = (v) =>
  typeof v === 'number'
    ? new Date(v + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
    : v == null
      ? ''
      : String(v);
const txt = (v) =>
  Array.isArray(v)
    ? v.map((x) => (x && x.text) || x).join('')
    : v && typeof v === 'object'
      ? (v.text ?? '')
      : v == null
        ? ''
        : String(v);
const isEmpty = (v) => v == null || v === '';

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = parseEnvFile(args.env);

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const feishuAppId = env.FEISHU_APP_ID;
  const feishuAppSecret = env.FEISHU_APP_SECRET;
  const appToken = (env.FEISHU_OPS_REPORT_APP_TOKEN || 'TM0hb4fmtaa5jusAnlnc32Nfnpg').trim();
  const tableId = (env.FEISHU_OPS_REPORT_TABLE_ID || 'tblusTgxaBKp9BA7').trim();
  const spongeBase = (env.SPONGE_API_BASE_URL || DEFAULT_SPONGE_API_BASE_URL).replace(/\/+$/, '');
  const selfListApi = `${spongeBase}/ai/api/workorder/signup/self/list`;

  if (!supabaseUrl || !supabaseKey) throw new Error('缺少 Supabase 配置');
  if (!feishuAppId || !feishuAppSecret) throw new Error('缺少飞书 APP_ID/SECRET');

  console.log(`[cfg] env=${args.env} apply=${args.apply} table=${tableId}`);

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // 1) hosting_member_config: wxid -> dulidayToken
  const { data: cfgRow, error: cfgErr } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', HOSTING_MEMBER_CONFIG_KEY)
    .single();
  if (cfgErr) throw new Error(`读取 hosting_member_config 失败: ${cfgErr.message}`);
  const tokenByWxid = new Map();
  for (const [wxid, entry] of Object.entries(cfgRow.value?.members || {})) {
    const tk = (entry?.dulidayToken || '').trim();
    if (tk) tokenByWxid.set(normalizeBotImId(wxid), tk);
  }
  console.log(`[cfg] 有 token 的账号数: ${tokenByWxid.size}`);

  // 2) 飞书 tenant token
  const tokRes = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: feishuAppId, app_secret: feishuAppSecret }),
  }).then((r) => r.json());
  if (tokRes.code) throw new Error(`飞书 token 失败: ${JSON.stringify(tokRes)}`);
  const feishuAuth = { Authorization: `Bearer ${tokRes.tenant_access_token}` };

  // 3) 读飞书全部记录
  let records = [];
  let pageToken;
  do {
    const p = new URLSearchParams({ page_size: '500' });
    if (pageToken) p.set('page_token', pageToken);
    const j = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${p}`,
      { headers: feishuAuth },
    ).then((r) => r.json());
    if (j.code) throw new Error(`读飞书记录失败: ${JSON.stringify(j)}`);
    records.push(...(j.data.items || []));
    pageToken = j.data.has_more ? j.data.page_token : undefined;
  } while (pageToken);

  const F_SIGNUP = '今日报名成功数';
  const F_PASS = '今日面试通过数';
  const rows = records.map((rec) => ({
    id: rec.record_id,
    date: fmtDate(rec.fields['日期'] ?? rec.fields['报名日期']),
    manager: txt(rec.fields['招募经理'] ?? rec.fields['招聘经理'] ?? rec.fields['账号']),
    group: txt(rec.fields['小组']),
    signupEmpty: isEmpty(rec.fields[F_SIGNUP]),
    passEmpty: isEmpty(rec.fields[F_PASS]),
  }));
  const gapRows = rows.filter((r) => r.date && (r.signupEmpty || r.passEmpty));
  const gapDates = [...new Set(gapRows.map((r) => r.date))].sort();
  console.log(`[feishu] 总记录 ${rows.length}，需补 ${gapRows.length} 行，日期 ${gapDates.length} 天`);
  console.log(`[feishu] 待补日期: ${gapDates.join(', ')}`);

  // 4) daily_ops_report: (date, manager_name) -> wxid ; (date, wxid) -> projected sums
  const { data: dor, error: dorErr } = await supabase
    .from('daily_ops_report')
    .select(
      'report_date, bot_im_id, manager_name, group_name, booking_success_count, interview_pass_count',
    )
    .in('report_date', gapDates);
  if (dorErr) throw new Error(`读取 daily_ops_report 失败: ${dorErr.message}`);
  const wxidByDateManager = new Map(); // `${date}|${manager}` -> wxid
  const wxidsByDateGroup = new Map(); // `${date}|${group}` -> Set<wxid>（唯一时可兜底匹配）
  const projByDateWxid = new Map(); // `${date}|${wxid}` -> {booking, pass}
  for (const r of dor) {
    const wxid = normalizeBotImId(r.bot_im_id);
    const dk = `${r.report_date}|${(r.manager_name || '').trim()}`;
    if (!wxidByDateManager.has(dk)) wxidByDateManager.set(dk, wxid);
    const gk = `${r.report_date}|${(r.group_name || '').trim()}`;
    if (!wxidsByDateGroup.has(gk)) wxidsByDateGroup.set(gk, new Set());
    wxidsByDateGroup.get(gk).add(wxid);
    const pk = `${r.report_date}|${wxid}`;
    const cur = projByDateWxid.get(pk) || { booking: 0, pass: 0 };
    cur.booking += r.booking_success_count || 0;
    cur.pass += r.interview_pass_count || 0;
    projByDateWxid.set(pk, cur);
  }
  // 按 (date, group) 唯一映射兜底（同名经理跨日改名时用组还原 wxid）。
  const uniqueWxidByDateGroup = new Map();
  for (const [gk, set] of wxidsByDateGroup) if (set.size === 1) uniqueWxidByDateGroup.set(gk, [...set][0]);

  // 5) 海绵 self/list 查询（缓存 per (date,wxid)）
  const spongeCache = new Map();
  async function spongeCount(date, wxid) {
    const ck = `${date}|${wxid}`;
    if (spongeCache.has(ck)) return spongeCache.get(ck);
    const token = tokenByWxid.get(wxid);
    if (!token) {
      spongeCache.set(ck, null);
      return null;
    }
    const start = `${date} 00:00:00`;
    const end = `${date} 23:59:59`;
    const query = async (queryParam) => {
      const res = await fetch(selfListApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Duliday-Token': token },
        body: JSON.stringify({ queryParam }),
      });
      if (!res.ok) throw new Error(`海绵 ${res.status} ${res.statusText}`);
      const j = await res.json();
      if (j.code !== 0) throw new Error(`海绵业务失败 code=${j.code} ${j.message || ''}`);
      const orders = j.data?.workOrders || [];
      const ids = new Set(orders.map((o) => o.workOrderId).filter((x) => Number.isFinite(x)));
      const uniqueLen = ids.size > 0 ? ids.size : orders.length;
      return Math.max(j.data?.total ?? 0, uniqueLen);
    };
    const booking = await query({ signUpStartTime: start, signUpEndTime: end });
    const pass = await query({ interviewPassStartTime: start, interviewPassEndTime: end });
    const out = { booking, pass, source: 'sponge' };
    spongeCache.set(ck, out);
    return out;
  }

  // 6) 计算每行的补值
  const plans = [];
  const unmatched = [];
  await mapLimit(gapRows, args.concurrency, async (row) => {
    const wxid =
      wxidByDateManager.get(`${row.date}|${row.manager}`) ??
      (row.group ? uniqueWxidByDateGroup.get(`${row.date}|${row.group}`) : undefined);
    if (!wxid) {
      unmatched.push(row);
      return;
    }
    let counts = await spongeCount(row.date, wxid);
    if (!counts) {
      const proj = projByDateWxid.get(`${row.date}|${wxid}`) || { booking: 0, pass: 0 };
      counts = { booking: proj.booking, pass: proj.pass, source: 'projected' };
    }
    const fields = {};
    if (row.signupEmpty) fields[F_SIGNUP] = counts.booking;
    if (row.passEmpty) fields[F_PASS] = counts.pass;
    plans.push({ row, wxid, counts, fields });
  });

  // 7) 输出
  plans.sort((a, b) => (a.row.date + a.row.group).localeCompare(b.row.date + b.row.group, 'zh'));
  console.log('\n=== 计划写入（仅空单元格）===');
  console.log('date | group | manager | 报名 | 通过 | 来源');
  for (const p of plans) {
    console.log(
      `${p.row.date} | ${p.row.group} | ${p.row.manager} | ` +
        `${p.row.signupEmpty ? p.counts.booking : '(已有)'} | ` +
        `${p.row.passEmpty ? p.counts.pass : '(已有)'} | ${p.counts.source}`,
    );
  }
  if (unmatched.length) {
    console.log(`\n=== 无法匹配 wxid（跳过，${unmatched.length} 行）===`);
    for (const r of unmatched) console.log(`${r.date} | ${r.group} | ${r.manager}`);
  }
  const spongeRows = plans.filter((p) => p.counts.source === 'sponge').length;
  const projRows = plans.filter((p) => p.counts.source === 'projected').length;
  console.log(
    `\n[汇总] 可写 ${plans.length} 行（海绵 ${spongeRows} / 投影兜底 ${projRows}）；跳过 ${unmatched.length} 行`,
  );

  if (!args.apply) {
    console.log('\n[dry-run] 未写入飞书。加 --apply 执行写入。');
    return;
  }

  // 8) 批量更新飞书
  const updates = plans
    .filter((p) => Object.keys(p.fields).length > 0)
    .map((p) => ({ record_id: p.row.id, fields: p.fields }));
  let ok = 0;
  let fail = 0;
  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    const j = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
      {
        method: 'POST',
        headers: { ...feishuAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: chunk }),
      },
    ).then((r) => r.json());
    if (j.code === 0) ok += chunk.length;
    else {
      fail += chunk.length;
      console.error(`批量更新失败: ${JSON.stringify(j)}`);
    }
  }
  console.log(`\n[apply] 写入完成：成功 ${ok}，失败 ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
