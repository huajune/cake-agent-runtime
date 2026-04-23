#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnvFile(filePath) {
  const env = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function createSupabaseFromEnv(envPath) {
  const env = loadEnvFile(envPath);
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function must(result, label) {
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  return result.data;
}

async function safeUpsert(client, table, rows, label, warnings) {
  if (!rows.length) return 0;
  const result = await client.from(table).upsert(rows, { onConflict: 'id' });
  if (result.error) {
    warnings.push(`${label} 跳过: ${result.error.message}`);
    return 0;
  }
  return rows.length;
}

function mapExecutionsForProd(executions) {
  return executions.map((execution) => {
    const sourceId = execution.conversation_snapshot_id || null;
    return {
      ...execution,
      conversation_source_id: sourceId,
    };
  });
}

async function main() {
  const batchIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
  if (batchIds.length === 0) {
    console.error(
      'Usage: node scripts/sync-test-suite-batches-to-prod.js <batch-id> [batch-id...]',
    );
    process.exit(1);
  }

  const repoRoot = process.cwd();
  const testEnvPath = path.join(repoRoot, '.env.local');
  const prodEnvPath = path.join(repoRoot, '.env.production');

  if (!fs.existsSync(testEnvPath) || !fs.existsSync(prodEnvPath)) {
    throw new Error('缺少 .env.local 或 .env.production，无法同步 test-suite 批次');
  }

  const testDb = createSupabaseFromEnv(testEnvPath);
  const prodDb = createSupabaseFromEnv(prodEnvPath);

  const [batchesRes, snapshotsRes, executionsRes] = await Promise.all([
    testDb.from('test_batches').select('*').in('id', batchIds),
    testDb.from('test_conversation_snapshots').select('*').in('batch_id', batchIds),
    testDb.from('test_executions').select('*').in('batch_id', batchIds),
  ]);

  const batches = await must(batchesRes, '读取测试环境 test_batches 失败');
  const snapshots = await must(snapshotsRes, '读取测试环境 test_conversation_snapshots 失败');
  const executions = await must(executionsRes, '读取测试环境 test_executions 失败');

  const warnings = [];

  const syncedBatches = await safeUpsert(prodDb, 'test_batches', batches, '生产 test_batches', warnings);
  const syncedSnapshotsNew = await safeUpsert(
    prodDb,
    'test_conversation_snapshots',
    snapshots,
    '生产 test_conversation_snapshots',
    warnings,
  );
  const syncedSnapshotsLegacy = await safeUpsert(
    prodDb,
    'conversation_test_sources',
    snapshots,
    '生产 conversation_test_sources',
    warnings,
  );
  const syncedExecutions = await safeUpsert(
    prodDb,
    'test_executions',
    mapExecutionsForProd(executions),
    '生产 test_executions',
    warnings,
  );

  const [prodBatchesRes, prodConversationsRes, prodExecutionsRes] = await Promise.all([
    prodDb
      .from('test_batches')
      .select(
        'id,name,test_type,status,total_cases,executed_count,passed_count,failed_count,pending_review_count,pass_rate',
      )
      .in('id', batchIds),
    prodDb
      .from('conversation_test_sources')
      .select('id,batch_id,participant_name,status,total_turns,avg_similarity_score')
      .in('batch_id', batchIds),
    prodDb.from('test_executions').select('id', { count: 'exact', head: true }).in('batch_id', batchIds),
  ]);

  const prodBatches = prodBatchesRes.error ? [] : prodBatchesRes.data || [];
  const prodConversations = prodConversationsRes.error ? [] : prodConversationsRes.data || [];
  const prodExecutionCount = prodExecutionsRes.error ? 0 : prodExecutionsRes.count || 0;

  console.log(
    JSON.stringify(
      {
        requestedBatchIds: batchIds,
        synced: {
          testBatches: syncedBatches,
          testConversationSnapshots: syncedSnapshotsNew,
          legacyConversationSources: syncedSnapshotsLegacy,
          testExecutions: syncedExecutions,
        },
        production: {
          batches: prodBatches,
          conversationSources: prodConversations,
          executionCount: prodExecutionCount,
        },
        warnings,
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
