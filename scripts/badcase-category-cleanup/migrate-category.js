#!/usr/bin/env node
// 「分类」清洗执行：
// 1) 备份 recordId→旧值 到 category-backup.json
// 2) 按 category-mapping.json 批量改写记录
// 3) 收敛字段选项：仅保留 15 主聊新口径 + 8 复聊分类 + 未分类
// 4) 复核最终分布与选项列表
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.dirname(__filename);
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, '.env.production'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }),
);

const APP_TOKEN = env.FEISHU_BITABLE_BADCASE_APP_TOKEN;
const TABLE_ID = env.FEISHU_BITABLE_BADCASE_TABLE_ID;
const MAPPING = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'category-mapping.json'), 'utf8'));

const KEEP_OPTIONS = [
  '1-地区、城市与位置识别',
  '2-品牌与门店识别',
  '3-就近岗位推荐',
  '4-岗位条件与班次匹配',
  '5-岗位详情、薪资与福利',
  '6-报名与收资',
  '7-预约、取消与改期',
  '8-线上面试与到店引导',
  '9-无岗承接与拉群',
  '10-重复回复与收口节奏',
  '11-图片与上下文理解',
  '12-内部术语与异常输出',
  '13-敏感条件与合规表达',
  '14-人工/非Agent归因',
  '15-其他',
  '1-不该触达（工单/条件误判）',
  '2-触达时机错误（过早/过晚）',
  '3-重复打扰（"已提醒过"误判）',
  '4-场景挂错',
  '5-话术事实错误（岗位/时间/状态不符）',
  '6-语气/话术不当',
  '7-取消/改期后仍按旧状态触达',
  '8-其他',
  '未分类',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(token, method, urlPath, body, params) {
  const url = new URL(`https://open.feishu.cn/open-apis${urlPath}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`${method} ${urlPath}: ${json.code} ${json.msg}`);
  return json.data;
}

async function main() {
  const tokenRes = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    },
  );
  const tokenJson = await tokenRes.json();
  if (tokenJson.code !== 0) throw new Error(`token: ${tokenJson.code} ${tokenJson.msg}`);
  const token = tokenJson.tenant_access_token;

  // 1) 全量拉取 + 备份
  const records = [];
  let pageToken = '';
  do {
    const data = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`, null, {
      page_size: '500',
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    records.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);

  const backup = {};
  for (const record of records) {
    const value = record.fields?.['分类'];
    if (typeof value === 'string' && value) backup[record.record_id] = value;
  }
  fs.writeFileSync(path.join(OUT_DIR, 'category-backup.json'), JSON.stringify(backup, null, 1));
  console.log(`已备份 ${Object.keys(backup).length} 条分类值 → category-backup.json`);

  // 2) 批量改写
  const updates = [];
  for (const [recordId, oldValue] of Object.entries(backup)) {
    const newValue = MAPPING[oldValue];
    if (newValue && newValue !== oldValue) {
      updates.push({ record_id: recordId, fields: { 分类: newValue } });
    }
  }
  console.log(`需要改写 ${updates.length} 条记录`);
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    await api(
      token,
      'POST',
      `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_update`,
      { records: chunk },
    );
    done += chunk.length;
    console.log(`  已改写 ${done}/${updates.length}`);
    await sleep(300);
  }

  // 3) 收敛选项：保留 KEEP_OPTIONS 中现存的（带原 id），丢弃其余
  const fieldsData = await api(
    token,
    'GET',
    `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`,
    null,
    { page_size: '100' },
  );
  const categoryField = (fieldsData.items || []).find((f) => f.field_name === '分类');
  if (!categoryField) throw new Error('未找到「分类」字段');
  const keepSet = new Set(KEEP_OPTIONS);
  const currentOptions = categoryField.property?.options || [];
  const retained = currentOptions.filter((o) => keepSet.has(o.name));
  const dropped = currentOptions.length - retained.length;
  await api(
    token,
    'PUT',
    `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields/${categoryField.field_id}`,
    {
      field_name: '分类',
      type: 3,
      property: { options: retained.map((o) => ({ id: o.id, name: o.name, color: o.color })) },
    },
  );
  console.log(`选项收敛完成：保留 ${retained.length} 个，删除 ${dropped} 个`);

  // 4) 复核
  const finalCounts = new Map();
  pageToken = '';
  do {
    const data = await api(token, 'GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`, null, {
      page_size: '500',
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    for (const record of data.items || []) {
      const value = record.fields?.['分类'];
      if (typeof value === 'string' && value)
        finalCounts.set(value, (finalCounts.get(value) || 0) + 1);
    }
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);
  console.log('\n迁移后「分类」分布:');
  const unexpected = [];
  for (const [value, count] of [...finalCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = keepSet.has(value) ? '' : '  ← 非白名单!';
    if (!keepSet.has(value)) unexpected.push(value);
    console.log(`  ${String(count).padStart(5)}  ${value}${flag}`);
  }
  if (unexpected.length > 0) {
    console.error(`\n警告：仍有 ${unexpected.length} 个非白名单取值`);
    process.exit(2);
  }
  console.log('\n全部取值均在白名单内，迁移完成。');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
