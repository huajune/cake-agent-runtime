import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 把本地 review 后的 BadCase 优先级回写飞书表格。
 *
 * 用法：
 *   pnpm tsx scripts/writeback-badcase-priority.ts                       # dry-run
 *   pnpm tsx scripts/writeback-badcase-priority.ts --apply               # 实写
 *   pnpm tsx scripts/writeback-badcase-priority.ts --env .env.production # 指定 env 文件
 */

type PriorityLevel = 'P0' | 'P1' | 'P2' | 'P3';

type Plan = {
  badcaseId: string;
  recordId: string;
  current: PriorityLevel;
  target: PriorityLevel;
  reason: string;
};

const PLANS: Plan[] = [
  // 升级到 P0：系统级红线 / 输出污染
  {
    badcaseId: 'vllg7hlu',
    recordId: 'recviaisqBAwjq',
    current: 'P2',
    target: 'P0',
    reason: '回复条代码片段，输出污染红线',
  },
  // 升级到 P1：日期/姓名/硬约面 / 消息合并退化
  {
    badcaseId: 'm5lpfwi0',
    recordId: 'recviazQwqJCJa',
    current: 'P2',
    target: 'P1',
    reason: '报名模板姓名预填错误，命中真名 guard 漏洞',
  },
  {
    badcaseId: 'bgsjb64r',
    recordId: 'recviaaKkvRXeI',
    current: 'P2',
    target: 'P1',
    reason: '日期推理错（周四=后天）',
  },
  {
    badcaseId: '1sy7d9ia',
    recordId: 'recviaTQtD6Ejd',
    current: 'P2',
    target: 'P1',
    reason: '用户明确拒绝仍激进约面',
  },
  {
    badcaseId: 'lmzv5x7y',
    recordId: 'recviaDkTygMGo',
    current: 'P2',
    target: 'P1',
    reason: '不回答工时直接约面 + 两条用户消息未合并',
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

async function updatePriority(
  token: string,
  appToken: string,
  tableId: string,
  recordId: string,
  priority: PriorityLevel,
): Promise<void> {
  const response = await axios.put(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields: { 优先级: priority } },
    {
      timeout: 15000,
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (response.data.code !== 0) {
    throw new Error(`更新优先级失败 record=${recordId}: ${response.data.msg}`);
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

  console.log(`[writeback] envPath=${envPath} apply=${apply}`);
  console.log(`[writeback] 计划变更 ${PLANS.length} 条:`);
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
      await updatePriority(token, appToken, tableId, plan.recordId, plan.target);
      success += 1;
      console.log(`  ✓ ${plan.badcaseId} → ${plan.target}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      errors.push(`${plan.badcaseId}: ${message}`);
      console.log(`  ✗ ${plan.badcaseId}: ${message}`);
    }
  }
  console.log(`\n[writeback] 完成 success=${success} failed=${failed}`);
  if (errors.length > 0) {
    console.log('错误明细:');
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[writeback] 失败: ${message}`);
  process.exit(1);
});
