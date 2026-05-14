#!/usr/bin/env node
/**
 * 同步"海绵岗位数据清洗"表格 schema + 批量录入数据问题。
 *
 * 用法：
 *   node scripts/sync-data-issues-to-feishu.js
 *
 * 行为：
 *   1. 读取 tmp/data-issues-batch-{YYYYMMDD}.json（默认今天）
 *   2. 拉取当前飞书表字段；缺失则按 schema 建好（重命名默认 Text → "问题ID"，
 *      其余字段按 type/options 创建）
 *   3. 批量插入 records（按 "问题ID" 幂等：已存在则跳过）
 */

const fs = require('fs');
const path = require('path');

// Lightweight .env.local loader
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
const APP_TOKEN = 'FOrKbBhNtashLasoSCscmeDznJd';
const TABLE_ID = 'tbl7jtvD7Ltw33GO';

if (!APP_ID || !APP_SECRET) {
  console.error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET in .env.local');
  process.exit(1);
}

// === Field schema ===
// 飞书 bitable type：1=Text  2=Number  3=SingleSelect  4=MultiSelect  5=DateTime
const SCHEMA = [
  { name: '问题ID', type: 1, primary: true },
  {
    name: '提交来源',
    type: 3,
    options: ['人工录入', 'Agent 自动上报', '后置守卫', '后置归类'],
  },
  {
    name: '问题分类',
    type: 3,
    options: [
      '品牌别名缺失',
      '岗位字段错',
      '召回过严 / 地区无岗错配',
      '备注过期',
      '同名地名歧义（业务方向待定）',
      '岗位字段错 / 平台外岗位口径',
      '性别要求错',
      '健康证规则错',
      '其他',
    ],
  },
  { name: '问题描述', type: 1 },
  { name: '涉及品牌', type: 4, options: ['成都你六姐', '奥乐齐', '必胜客', '肯德基', '果蔬好', '山姆'] },
  { name: '涉及jobId', type: 1 },
  { name: '涉及门店', type: 1 },
  { name: '涉及城市/区域', type: 1 },
  { name: '候选人原话', type: 1 },
  { name: '来源chatId', type: 1 },
  { name: '来源badcaseId', type: 1 },
  { name: '优先级', type: 3, options: ['P0', 'P1', 'P2', 'P3'] },
  { name: '状态', type: 3, options: ['待审核', '已确认', '处理中', '已修复', '已忽略'] },
  {
    name: '责任方',
    type: 3,
    options: ['运营', '产品', '数据', '招募团队', '数据 / 运营', '数据 / 产品'],
  },
  { name: '修复说明', type: 1 },
  { name: '修复时间', type: 5 },
];

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

async function listAllFields(token) {
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (j.code !== 0) throw new Error(`listFields: ${j.msg}`);
  return j.data?.items || [];
}

async function renameField(token, fieldId, newName) {
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields/${fieldId}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ field_name: newName, type: 1 }),
    },
  );
  const j = await r.json();
  if (j.code !== 0) throw new Error(`renameField(${newName}): ${j.msg}`);
  return j.data?.field;
}

async function createField(token, def) {
  const body = { field_name: def.name, type: def.type };
  if (def.options) {
    body.property = { options: def.options.map((name) => ({ name })) };
  }
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const j = await r.json();
  if (j.code !== 0) throw new Error(`createField(${def.name}): ${j.msg}`);
  return j.data?.field;
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
    all.push(...(j.data?.items || []));
    pageToken = j.data?.has_more ? j.data?.page_token : undefined;
  } while (pageToken);
  return all;
}

function recordToFields(rec) {
  const f = {
    问题ID: rec['问题ID'],
    提交来源: rec['提交来源'] || '人工录入',
    问题分类: rec['问题分类'],
    问题描述: rec['问题描述'],
    'jobId': rec['涉及jobId'] || undefined,
    涉及门店: rec['涉及门店'] || undefined,
    '涉及城市/区域': rec['涉及城市/区域'] || undefined,
    候选人原话: rec['候选人原话'] || undefined,
    'chatId': rec['来源chatId'] || undefined,
    'badcaseId': rec['来源badcaseId'] || undefined,
    优先级: rec['优先级'],
    状态: rec['状态'] || '待审核',
    责任方: rec['责任方'] || undefined,
    修复说明: rec['修复说明'] || undefined,
  };
  // 多选品牌
  if (Array.isArray(rec['涉及品牌']) && rec['涉及品牌'].length > 0) {
    f['涉及品牌'] = rec['涉及品牌'];
  }
  // 把含点的真实字段名补上（recordToFields 上面的 alias 是占位）
  f['涉及jobId'] = rec['涉及jobId'] || undefined;
  f['来源chatId'] = rec['来源chatId'] || undefined;
  f['来源badcaseId'] = rec['来源badcaseId'] || undefined;
  delete f['jobId'];
  delete f['chatId'];
  delete f['badcaseId'];
  // 移除 undefined（飞书会拒绝 null 值的单选字段）
  for (const k of Object.keys(f)) {
    if (f[k] == null || f[k] === '') delete f[k];
  }
  return f;
}

async function batchCreate(token, records) {
  if (records.length === 0) return { records: [] };
  const body = { records: records.map((fields) => ({ fields })) };
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_create`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const j = await r.json();
  if (j.code !== 0) throw new Error(`batchCreate: ${j.msg} ${JSON.stringify(j)}`);
  return j.data;
}

async function batchUpdate(token, updates) {
  if (updates.length === 0) return { records: [] };
  const body = { records: updates.map(({ record_id, fields }) => ({ record_id, fields })) };
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_update`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const j = await r.json();
  if (j.code !== 0) throw new Error(`batchUpdate: ${j.msg} ${JSON.stringify(j)}`);
  return j.data;
}

/** 飞书文本字段读出来可能是 string 或 [{text:'...'}]，归一化成 string。 */
function normalizeFieldValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return '';
    if (typeof v[0] === 'string') return v.join(',');
    if (v[0]?.text != null) return v.map((p) => p.text ?? '').join('');
    if (v[0]?.name != null) return v.map((p) => p.name).join(',');
  }
  if (typeof v === 'object') return v.text ?? v.name ?? '';
  return String(v);
}

/** 检查 desired fields 与 existing fields 是否需要 update（仅比对 desired 中的 keys）。 */
function diffFields(desired, existing) {
  const changed = {};
  for (const k of Object.keys(desired)) {
    const desiredVal = desired[k];
    const existingNorm = normalizeFieldValue(existing[k]);
    // 多选：desired 是数组，飞书也返回数组
    if (Array.isArray(desiredVal)) {
      const existingArr = Array.isArray(existing[k])
        ? existing[k].map((p) => (typeof p === 'string' ? p : p?.name ?? p?.text ?? ''))
        : [];
      if (JSON.stringify([...desiredVal].sort()) !== JSON.stringify([...existingArr].sort())) {
        changed[k] = desiredVal;
      }
    } else if (String(desiredVal) !== existingNorm) {
      changed[k] = desiredVal;
    }
  }
  return changed;
}

(async () => {
  console.log('[1/4] getting tenant_access_token...');
  const token = await getTenantToken();

  console.log('[2/4] reading data-issues batch json...');
  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dataPath = path.resolve(__dirname, '..', 'tmp', `data-issues-batch-${todayStr}.json`);
  if (!fs.existsSync(dataPath)) {
    console.error(`File not found: ${dataPath}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const records = data.records || [];
  console.log(`  found ${records.length} records`);

  console.log('[3/4] ensuring field schema...');
  let fields = await listAllFields(token);
  const fieldByName = Object.fromEntries(fields.map((f) => [f.field_name, f]));
  // 重命名默认 Text -> 问题ID（如果还存在）
  if (fieldByName['Text'] && !fieldByName['问题ID']) {
    console.log('  rename Text -> 问题ID');
    await renameField(token, fieldByName['Text'].field_id, '问题ID');
    fields = await listAllFields(token);
  }
  const existing = new Set(fields.map((f) => f.field_name));
  for (const def of SCHEMA) {
    if (existing.has(def.name)) continue;
    console.log(`  create field: ${def.name} (type=${def.type})`);
    await createField(token, def);
  }

  console.log('[4/4] upserting records (idempotent by 问题ID)...');
  const allRecs = await listAllRecords(token);
  const existingMap = new Map();
  for (const r of allRecs) {
    const id = normalizeFieldValue(r.fields?.['问题ID']);
    if (id) existingMap.set(id, r);
  }
  const toCreate = [];
  const toUpdate = [];
  let unchanged = 0;
  for (const rec of records) {
    const id = rec['问题ID'];
    const desired = recordToFields(rec);
    const existing = existingMap.get(id);
    if (!existing) {
      toCreate.push(desired);
      continue;
    }
    const changed = diffFields(desired, existing.fields || {});
    if (Object.keys(changed).length === 0) {
      unchanged += 1;
    } else {
      toUpdate.push({ record_id: existing.record_id, fields: changed });
    }
  }
  if (toCreate.length > 0) {
    const res = await batchCreate(token, toCreate);
    console.log(`  created: ${res.records?.length ?? 0}`);
  } else {
    console.log('  created: 0');
  }
  if (toUpdate.length > 0) {
    const res = await batchUpdate(token, toUpdate);
    console.log(`  updated: ${res.records?.length ?? 0}`);
    for (const u of toUpdate) {
      console.log(`    - ${Object.keys(u.fields).join(', ')}`);
    }
  } else {
    console.log('  updated: 0');
  }
  console.log(`  unchanged: ${unchanged}`);
  console.log('done.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
