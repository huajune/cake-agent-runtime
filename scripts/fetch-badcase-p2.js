#!/usr/bin/env node
/* 一次性脚本：从飞书 BadCase 多维表拉取最新 P2 数据并落到 tmp/。 */
const fs = require('fs');
const path = require('path');

// Lightweight .env.local loader (no dotenv dependency)
(() => {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] != null) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
})();

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const APP_TOKEN = process.env.FEISHU_BITABLE_BADCASE_APP_TOKEN;
const TABLE_ID = process.env.FEISHU_BITABLE_BADCASE_TABLE_ID;

if (!APP_ID || !APP_SECRET || !APP_TOKEN || !TABLE_ID) {
  console.error('Missing FEISHU_APP_ID/SECRET or BADCASE app_token/table_id in .env.local');
  process.exit(1);
}

const args = process.argv.slice(2);
const onlyUnresolved = args.includes('--unresolved');
const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function getTenantToken() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`tenant_access_token: ${j.msg}`);
  return j.tenant_access_token;
}

async function listAllRecords(token) {
  const all = [];
  let pageToken;
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
    );
    url.searchParams.set('page_size', '500');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`listRecords: ${j.msg}`);
    const items = j.data?.items || [];
    all.push(...items);
    pageToken = j.data?.page_token;
    if (j.data?.has_more === false) pageToken = undefined;
  } while (pageToken);
  return all;
}

function pickField(fields, aliases) {
  for (const a of aliases) {
    if (fields[a] != null && fields[a] !== '') return fields[a];
  }
  return undefined;
}

function flattenText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (typeof p === 'string' ? p : p?.text ?? p?.value ?? ''))
      .filter(Boolean)
      .join('');
  }
  if (typeof v === 'object') return v.text ?? v.value ?? JSON.stringify(v);
  return String(v);
}

function flattenSelect(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => p?.text ?? p?.name ?? p).join(',');
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

const ALIASES = {
  badcaseId: ['问题ID', '样本ID', 'sampleId', 'issueId'],
  priority: ['优先级'],
  status: ['状态'],
  category: ['分类', '错误分类'],
  source: ['来源'],
  consultTime: ['咨询时间', '提交时间', '创建时间'],
  candidateName: ['候选人微信昵称', '候选人姓名', '参与者', '姓名'],
  managerName: ['招募经理姓名', '招募经理', '负责人'],
  userMessage: ['用户消息', '问题', '用户输入'],
  chatHistory: ['聊天记录', '完整对话记录', '对话记录'],
  remark: ['备注', '说明', '附注'],
  chatId: ['chatId', '会话ID', '会话 Id', '会话ID（chatId）'],
  traceId: ['traceId', 'TraceID', 'Agent Trace ID', '运行TraceID'],
  batchId: ['Batch ID', 'BatchID', 'batchId', 'batch_id', '批次ID', '批次 ID', '测试批次'],
  caseName: ['用例名称'],
  title: ['标题', '名称'],
};

function normalize(rec) {
  const f = rec.fields || {};
  const out = { recordId: rec.record_id };
  for (const [k, aliases] of Object.entries(ALIASES)) {
    const v = pickField(f, aliases);
    if (v == null) continue;
    if (k === 'consultTime') {
      out[k] = typeof v === 'number' ? v : Number(v) || undefined;
    } else if (['priority', 'status', 'category', 'source'].includes(k)) {
      out[k] = flattenSelect(v);
    } else {
      out[k] = flattenText(v);
    }
  }
  return out;
}

(async () => {
  console.log('[fetch] getting tenant_access_token...');
  const token = await getTenantToken();
  console.log('[fetch] listing all records (paged)...');
  const raw = await listAllRecords(token);
  console.log(`[fetch] fetched ${raw.length} raw records`);

  const records = raw.map(normalize);
  const p2 = records.filter((r) => r.priority === 'P2');
  const p2Unresolved = p2.filter((r) => r.status && r.status !== '已解决');

  const outAll = path.resolve(__dirname, '..', 'tmp', `badcase-p2-source-${todayStr}.json`);
  const outUnresolved = path.resolve(
    __dirname,
    '..',
    'tmp',
    `badcase-p2-unresolved-source-${todayStr}.json`,
  );

  fs.writeFileSync(
    outAll,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), total: p2.length, records: p2 },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    outUnresolved,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: p2Unresolved.length,
        records: p2Unresolved,
      },
      null,
      2,
    ),
  );

  // Status & category breakdown
  const byStatus = {};
  const byCategory = {};
  for (const r of p2) {
    byStatus[r.status || '(空)'] = (byStatus[r.status || '(空)'] || 0) + 1;
    byCategory[r.category || '(空)'] = (byCategory[r.category || '(空)'] || 0) + 1;
  }
  console.log('---');
  console.log(`raw total: ${records.length}`);
  console.log(`P2 total: ${p2.length}`);
  console.log(`P2 unresolved: ${p2Unresolved.length}`);
  console.log('P2 status:', byStatus);
  console.log('P2 category:', byCategory);
  console.log('written:', outAll);
  console.log('written:', outUnresolved);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
