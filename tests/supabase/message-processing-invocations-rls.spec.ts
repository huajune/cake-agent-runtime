import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationPath = join(
  process.cwd(),
  'supabase/migrations/20260903130000_secure_message_processing_invocations_rls.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('message_processing_invocations RLS migration', () => {
  it('enables RLS on the exposed public table', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.message_processing_invocations\s+ENABLE ROW LEVEL SECURITY;/,
    );
  });

  it('removes Data API access from public client roles', () => {
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES\s+ON TABLE public\.message_processing_invocations\s+FROM PUBLIC, anon, authenticated;/,
    );
  });

  it('keeps explicit service-role access for the backend repository', () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.message_processing_invocations\s+TO service_role;/,
    );
    expect(migration).toMatch(/FOR ALL\s+TO service_role\s+USING \(true\)\s+WITH CHECK \(true\);/);
  });
});
