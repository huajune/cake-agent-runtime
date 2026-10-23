/** pnpm exec ts-node -r tsconfig-paths/register scripts/cleanup-memory-integrity.ts --env .env.local [--apply --backup /private/path.jsonl] */
import * as fs from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { cleanMemoryFacts, isValidSummaryEntry } from '../src/memory/memory-integrity';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (key: string, fallback: string): string =>
    args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const apply = args.includes('--apply');
  const config = parseEnv(fs.readFileSync(option('--env', '.env.local'), 'utf8'));
  const client = createClient(
    config.SUPABASE_URL || config.NEXT_PUBLIC_SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false },
    },
  );
  const backup = option('--backup', '');
  if (apply && !backup) throw new Error('apply requires a new private backup file');
  const fd = apply ? fs.openSync(backup, 'wx', 0o600) : null;
  const now = new Date();
  const stats = { scanned: 0, changed: 0, updated: 0, concurrentSkipped: 0, emptyRows: 0 };
  let cursor: string | null = null;
  try {
    while (stats.scanned < 40000) {
      let q = client.from('agent_long_term_memories').select('*').order('id').limit(100);
      if (cursor) q = q.gt('id', cursor);
      const { data, error } = await q;
      if (error) throw error;
      if (!data.length) break;
      for (const row of data) {
        stats.scanned++;
        cursor = row.id;
        const profile = cleanMemoryFacts(row.semantic_profile, now);
        const intent = cleanMemoryFacts(row.semantic_job_intent, now);
        const summaries = Array.isArray(row.episodic_session_summaries)
          ? row.episodic_session_summaries
              .filter(isValidSummaryEntry)
              .sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime))
              .slice(-20)
          : [];
        const patch = {
          semantic_profile: profile,
          semantic_job_intent: intent,
          episodic_session_summaries: summaries,
        };
        // 此脚本不删除行：metadata、水位、预约版本、冻结记忆均须保留，纯空行单独盘点。
        const emptyFacts = (facts: Record<string, unknown> | null): boolean =>
          !facts || Object.values(facts).every((v) => v == null);
        if (
          emptyFacts(profile) &&
          emptyFacts(intent) &&
          !summaries.length &&
          !row.message_metadata &&
          !row.active_booking &&
          !Object.keys(row.active_booking_versions ?? {}).length &&
          !Object.keys(row.consolidation_watermarks?.bySession ?? {}).length &&
          !row.consolidation_watermarks?.lastSettledMessageAt
        )
          stats.emptyRows++;
        if (
          Object.entries(patch).every(
            ([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value),
          )
        )
          continue;
        stats.changed++;
        if (!apply) continue;
        fs.writeSync(
          fd!,
          JSON.stringify({ before: row, after: patch, auditedAt: now.toISOString() }) + '\n',
        );
        fs.fsyncSync(fd!);
        const { data: written, error: writeError } = await client
          .from('agent_long_term_memories')
          .update(patch)
          .eq('id', row.id)
          .eq('updated_at', row.updated_at)
          .select('id');
        if (writeError) throw writeError;
        if (written.length) stats.updated++;
        else stats.concurrentSkipped++;
      }
    }
    if (stats.scanned >= 40000)
      throw new Error('scan cap reached; inspect remaining rows before widening scope');
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  console.log(JSON.stringify(stats));
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
