#!/usr/bin/env node

/**
 * BadCase 历史证据治理入口。默认 dry-run，只有显式传 --apply 才会创建字段并回写。
 *
 * 用法：
 *   node scripts/backfill-badcase-evidence.js
 *   node scripts/backfill-badcase-evidence.js --apply
 *   node scripts/backfill-badcase-evidence.js --base-url=http://127.0.0.1:8586 --max-batches=3000
 */

const args = new Set(process.argv.slice(2));
const readArg = (prefix, fallback) => {
  const item = [...args].find((arg) => arg.startsWith(`${prefix}=`));
  return item ? item.slice(prefix.length + 1) : fallback;
};
const apply = args.has('--apply');
const baseUrl = readArg('--base-url', process.env.BADCASE_GOVERNANCE_API_BASE_URL || 'http://127.0.0.1:8586');
const maxBatches = Number(readArg('--max-batches', '2000'));
const token = process.env.API_GUARD_TOKEN;

if (!token) {
  console.error('缺少 API_GUARD_TOKEN；请先加载服务对应环境变量。');
  process.exit(1);
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const schema = await post('/feishu/sync/badcase-governance/schema', { apply });
  const evidence = await post('/test-suite/badcase-governance/backfill-evidence', {
    apply,
    maxBatches,
  });
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        schema,
        evidence,
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
