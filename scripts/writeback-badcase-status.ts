import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 把本地复盘后的 BadCase 状态扭转到飞书表格。
 *
 * 用法：
 *   pnpm tsx scripts/writeback-badcase-status.ts                       # dry-run
 *   pnpm tsx scripts/writeback-badcase-status.ts --apply               # 实写
 *   pnpm tsx scripts/writeback-badcase-status.ts --env .env.production # 指定 env 文件
 */

type BadcaseStatus = '待分析' | '处理中' | '待验证' | '已解决';

type Plan = {
  badcaseId: string;
  recordId: string;
  current: BadcaseStatus;
  target: BadcaseStatus;
  reason: string;
};

const PLANS: Plan[] = [
  // 三层托管 guard（worker / 投递前置 / 投递段间）已落地
  {
    badcaseId: '1tsdimfg',
    recordId: 'recvi99nkgBYyb',
    current: '待分析',
    target: '已解决',
    reason: '三层托管 guard 已落地（Worker 拉起 + 投递前 + 段间）',
  },
];

type EnvMap = Record<string, string>;

function parseEnv(envPath: string): EnvMap {
  if (!fs.existsSync(envPath)) {
    throw new Error(`找不到环境文件: ${envPath}`);
  }
  const text = fs.readFileSync(envPath, 'utf-8');
  const env: EnvMap = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
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

function parseArgs() {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env');
  return {
    apply: args.includes('--apply'),
    envPath:
      envIdx >= 0 && envIdx < args.length - 1
        ? path.resolve(args[envIdx + 1])
        : path.resolve(process.cwd(), '.env.local'),
  };
}

async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  const response = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: appId, app_secret: appSecret },
    { timeout: 15000 },
  );
  if (response.data.code !== 0) {
    throw new Error(`获取飞书 Token 失败: ${response.data.msg}`);
  }
  return response.data.tenant_access_token as string;
}

async function updateStatus(
  token: string,
  appToken: string,
  tableId: string,
  recordId: string,
  status: BadcaseStatus,
): Promise<void> {
  const response = await axios.put(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields: { 状态: status } },
    {
      timeout: 15000,
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (response.data.code !== 0) {
    throw new Error(`更新状态失败 record=${recordId}: ${response.data.msg}`);
  }
}

async function main(): Promise<void> {
  const { apply, envPath } = parseArgs();
  const env = parseEnv(envPath);

  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  const appToken = env.FEISHU_BITABLE_BADCASE_APP_TOKEN;
  const tableId = env.FEISHU_BITABLE_BADCASE_TABLE_ID;

  if (!appId || !appSecret || !appToken || !tableId) {
    throw new Error(`环境变量不完整 envPath=${envPath}`);
  }

  console.log(`[writeback-status] envPath=${envPath} apply=${apply}`);
  console.log(`[writeback-status] 计划变更 ${PLANS.length} 条:`);
  for (const plan of PLANS) {
    console.log(
      `  - ${plan.badcaseId} (${plan.recordId}) ${plan.current} → ${plan.target}  // ${plan.reason}`,
    );
  }

  if (!apply) {
    console.log('\n[dry-run] 未传 --apply，仅打印计划，未发起请求');
    return;
  }

  const token = await getTenantToken(appId, appSecret);
  let success = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const plan of PLANS) {
    try {
      await updateStatus(token, appToken, tableId, plan.recordId, plan.target);
      success += 1;
      console.log(`  ✓ ${plan.badcaseId} → ${plan.target}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      errors.push(`${plan.badcaseId}: ${message}`);
      console.log(`  ✗ ${plan.badcaseId}: ${message}`);
    }
  }
  console.log(`\n[writeback-status] 完成 success=${success} failed=${failed}`);
  if (errors.length > 0) {
    console.log('错误明细:');
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[writeback-status] 失败: ${message}`);
  process.exit(1);
});
