/**
 * 跨环境同步 strategy_config 内容字段。
 *
 * 默认 dry-run，只做对比不写入。
 *
 * 用法：
 * node -r ts-node/register/transpile-only scripts/sync-strategy-configs.ts
 * node -r ts-node/register/transpile-only scripts/sync-strategy-configs.ts --apply
 * node -r ts-node/register/transpile-only scripts/sync-strategy-configs.ts --apply --status=released
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type SyncStatus = 'testing' | 'released';

type StrategyConfigRow = {
  id: string;
  name: string;
  description: string | null;
  role_setting: unknown;
  persona: unknown;
  stage_goals: unknown;
  red_lines: unknown;
  industry_skills: unknown;
  is_active: boolean;
  status: SyncStatus | 'archived';
  version: number;
  version_note: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
};

const CONTENT_FIELDS = [
  'name',
  'description',
  'role_setting',
  'persona',
  'stage_goals',
  'red_lines',
  'industry_skills',
] as const;

type ContentField = (typeof CONTENT_FIELDS)[number];
type StrategyContentPayload = Pick<StrategyConfigRow, ContentField>;

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const statusArg = args.find((arg) => arg.startsWith('--status='));
  const statuses = statusArg
    ? statusArg
        .split('=')[1]
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is SyncStatus => value === 'testing' || value === 'released')
    : (['testing', 'released'] satisfies SyncStatus[]);

  if (statuses.length === 0) {
    throw new Error('`--status` 只支持 testing,released');
  }

  return {
    apply,
    statuses,
    sourceEnvPath: path.resolve(process.cwd(), '.env.local'),
    targetEnvPath: path.resolve(process.cwd(), '.env.production'),
  };
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`环境文件不存在: ${filePath}`);
  }

  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex < 0) {
          return [line, ''];
        }
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

function createSupabaseClientFromEnv(filePath: string): SupabaseClient {
  const env = parseEnvFile(filePath);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(`缺少 Supabase 配置: ${filePath}`);
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function fetchActiveConfigs(
  client: SupabaseClient,
  envName: string,
): Promise<Record<SyncStatus, StrategyConfigRow>> {
  const { data, error } = await client
    .from('strategy_config')
    .select(
      'id,name,description,role_setting,persona,stage_goals,red_lines,industry_skills,is_active,status,version,version_note,released_at,created_at,updated_at',
    )
    .eq('is_active', true)
    .in('status', ['testing', 'released']);

  if (error) {
    throw new Error(`${envName} 查询 strategy_config 失败: ${error.message}`);
  }

  const rows = (data ?? []) as StrategyConfigRow[];
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, row])) as Partial<
    Record<SyncStatus, StrategyConfigRow>
  >;

  if (!byStatus.testing || !byStatus.released) {
    throw new Error(
      `${envName} 缺少激活策略配置，当前仅找到: ${rows.map((row) => row.status).join(', ') || '无'}`,
    );
  }

  return {
    testing: byStatus.testing,
    released: byStatus.released,
  };
}

function buildContentPayload(row: StrategyConfigRow): StrategyContentPayload {
  return {
    name: row.name,
    description: row.description,
    role_setting: row.role_setting,
    persona: row.persona,
    stage_goals: row.stage_goals,
    red_lines: row.red_lines,
    industry_skills: row.industry_skills,
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortValue(nestedValue)]),
    );
  }

  return value;
}

function isEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function getChangedFields(source: StrategyConfigRow, target: StrategyConfigRow): ContentField[] {
  return CONTENT_FIELDS.filter((field) => !isEqual(source[field], target[field]));
}

async function main() {
  const { apply, statuses, sourceEnvPath, targetEnvPath } = parseArgs();
  const sourceLabel = `.env.local (${path.basename(sourceEnvPath)})`;
  const targetLabel = `.env.production (${path.basename(targetEnvPath)})`;

  console.log(`\n策略配置同步开始: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`source: ${sourceLabel}`);
  console.log(`target: ${targetLabel}`);
  console.log(`statuses: ${statuses.join(', ')}\n`);

  const sourceClient = createSupabaseClientFromEnv(sourceEnvPath);
  const targetClient = createSupabaseClientFromEnv(targetEnvPath);

  const [sourceConfigs, targetConfigs] = await Promise.all([
    fetchActiveConfigs(sourceClient, sourceLabel),
    fetchActiveConfigs(targetClient, targetLabel),
  ]);

  const changedStatuses: SyncStatus[] = [];

  for (const status of statuses) {
    const source = sourceConfigs[status];
    const target = targetConfigs[status];
    const changedFields = getChangedFields(source, target);

    console.log(`[${status}]`);
    console.log(`  source id=${source.id} version=${source.version}`);
    console.log(`  target id=${target.id} version=${target.version}`);

    if (changedFields.length === 0) {
      console.log('  diff: no changes\n');
      continue;
    }

    console.log(`  diff fields: ${changedFields.join(', ')}\n`);
    changedStatuses.push(status);

    if (!apply) {
      continue;
    }

    const payload = buildContentPayload(source);
    const { data, error } = await targetClient
      .from('strategy_config')
      .update(payload)
      .eq('id', target.id)
      .select('id,status,updated_at')
      .single();

    if (error) {
      throw new Error(`${targetLabel} 更新 ${status} 失败: ${error.message}`);
    }

    console.log(`  updated target row: ${data.id} @ ${data.updated_at}\n`);
  }

  if (changedStatuses.length === 0) {
    console.log('没有需要同步的差异，结束。');
    return;
  }

  if (!apply) {
    console.log(`dry-run 完成，待同步 status: ${changedStatuses.join(', ')}`);
    console.log('如需执行写入，请追加 --apply');
    return;
  }

  console.log(`同步完成，已更新 status: ${changedStatuses.join(', ')}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n同步失败: ${message}`);
  process.exit(1);
});
