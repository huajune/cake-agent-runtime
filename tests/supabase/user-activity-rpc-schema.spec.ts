import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260903104200_fix_user_activity_rpc_schema_drift.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('user_activity RPC schema drift migration', () => {
  it('writes all non-null activity timestamps in upsert_user_activity', () => {
    const upsertBody = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION upsert_user_activity'),
      migration.indexOf('DROP FUNCTION IF EXISTS get_active_users_from_user_activity_by_range'),
    );

    expect(upsertBody).toContain('first_active_at');
    expect(upsertBody).toContain('last_active_at');
    expect(upsertBody).toMatch(/p_active_at,\s*\n\s*p_active_at,\s*\n\s*now\(\)/);
  });

  it('drops and recreates the range RPC without deleted group columns', () => {
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS get_active_users_from_user_activity_by_range(timestamptz, timestamptz)',
    );

    const rangeRpcBody = migration.slice(
      migration.indexOf('CREATE FUNCTION get_active_users_from_user_activity_by_range'),
      migration.indexOf('COMMENT ON FUNCTION get_active_users_from_user_activity_by_range'),
    );

    expect(rangeRpcBody).toContain('first_active_at timestamptz');
    expect(rangeRpcBody).toContain('last_active_at  timestamptz');
    expect(rangeRpcBody).not.toContain('group_id');
    expect(rangeRpcBody).not.toContain('group_name');
    expect(rangeRpcBody).toContain('ORDER BY MAX(ua.last_active_at) DESC, ua.chat_id ASC');
  });

  it('backfills the incident window idempotently from retained source tables', () => {
    expect(migration).toContain('FROM chat_messages cm');
    expect(migration).toContain('FROM message_processing_records mpr');
    expect(migration).toContain(
      'message_count   = GREATEST(user_activity.message_count, EXCLUDED.message_count)',
    );
    expect(migration).toContain(
      'token_usage     = GREATEST(user_activity.token_usage, EXCLUDED.token_usage)',
    );
  });
});
