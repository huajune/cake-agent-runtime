#!/usr/bin/env node
/**
 * 周报数据采集：BadCase 表窗口统计（只读，不写任何数据）
 *
 * 用法：
 *   node scripts/weekly-ops-report/collect-badcase-stats.js [since] [until]
 *   node scripts/weekly-ops-report/collect-badcase-stats.js 2026-07-27 2026-08-03
 *
 * 默认窗口 = 本周一 00:00 至下周一 00:00（本地时区）。
 * 凭证取自 .env.production（BadCase 表在生产飞书空间，测试库无此数据）。
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '../../.env.production');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`缺少 ${ENV_PATH}——BadCase 表凭证只在生产环境文件中`);
  }
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const matched = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (matched) env[matched[1]] = matched[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function defaultWindow() {
  const now = new Date();
  const monday = new Date(now);
  const offsetToMonday = (now.getDay() + 6) % 7;
  monday.setDate(now.getDate() - offsetToMonday);
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return [monday, nextMonday];
}

function toTimestamp(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

function toText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => item.text || item.name || '').join(',');
  if (value && typeof value === 'object' && 'text' in value) return String(value.text);
  return value === undefined || value === null ? '' : String(value);
}

function tally(records, field) {
  const counts = {};
  for (const record of records) {
    const key = toText(record.fields[field]) || '(空)';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

async function fetchTenantToken(env) {
  const response = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    },
  ).then((res) => res.json());
  if (!response.tenant_access_token) throw new Error(`取 token 失败: ${JSON.stringify(response)}`);
  return response.tenant_access_token;
}

async function fetchAllRecords(token, appToken, tableId) {
  const records = [];
  let pageToken = '';
  do {
    const url =
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records` +
      `?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(
      (res) => res.json(),
    );
    if (response.code !== 0) throw new Error(`读表失败: ${JSON.stringify(response)}`);
    records.push(...(response.data.items || []));
    pageToken = response.data.has_more ? response.data.page_token : '';
  } while (pageToken);
  return records;
}

async function main() {
  const env = loadEnv();
  const [defaultStart, defaultEnd] = defaultWindow();
  const start = process.argv[2] ? new Date(process.argv[2]) : defaultStart;
  const end = process.argv[3] ? new Date(process.argv[3]) : defaultEnd;

  const token = await fetchTenantToken(env);
  const all = await fetchAllRecords(
    token,
    env.FEISHU_BITABLE_BADCASE_APP_TOKEN,
    env.FEISHU_BITABLE_BADCASE_TABLE_ID,
  );

  const submittedInWindow = all.filter((record) => {
    const timestamp = toTimestamp(
      record.fields['咨询时间'] ?? record.fields['提交时间'] ?? record.fields['创建时间'],
    );
    return Number.isFinite(timestamp) && timestamp >= start.getTime() && timestamp < end.getTime();
  });

  const output = {
    window: { since: start.toISOString(), until: end.toISOString() },
    total: all.length,
    totalByStatus: tally(all, '状态'),
    submittedInWindow: submittedInWindow.length,
    windowByStatus: tally(submittedInWindow, '状态'),
    windowByCategory: tally(submittedInWindow, '分类'),
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(`[weekly-ops-report] ${error.message}`);
  process.exit(1);
});
