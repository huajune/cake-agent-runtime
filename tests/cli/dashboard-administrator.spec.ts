import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminUserAttributes, SupabaseClient } from '@supabase/supabase-js';
import { initializeDashboardAdministrator } from '../../src/cli/dashboard-administrator';
import { DASHBOARD_ADMIN_EMAIL, DASHBOARD_ADMIN_LOGIN } from '../../src/types/dashboard-account';

it('uses the supplied administrator password once and preserves it on retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-admin-'));
  const project = 'https://example.invalid';
  const batch = {
    project,
    id: '10000000-0000-4000-8000-000000000001',
    password: 'QA-only-4297',
  };
  let user: AdminUserAttributes | undefined;
  const createUser = jest.fn(async (attributes: AdminUserAttributes) => {
    user = attributes;
    return { error: null };
  });
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: user
              ? { user_id: batch.id, disabled: false, organization: 'headquarters' }
              : null,
          }),
        }),
      }),
    }),
    auth: {
      admin: {
        createUser,
        getUserById: async () => ({
          data: { user: { ...user, id: batch.id, email_confirmed_at: 'confirmed' } },
        }),
      },
    },
  } as unknown as SupabaseClient;
  try {
    const working = join(directory, 'cakeadmin.work.json');
    const initialize = () => initializeDashboardAdministrator(client, directory, project);
    await writeFile(working, JSON.stringify({ ...batch, password: 'short' }), { mode: 0o600 });
    await expect(initialize()).rejects.toThrow();
    expect(createUser).not.toHaveBeenCalled();
    await writeFile(working, JSON.stringify(batch), { mode: 0o600 });
    await initialize();
    await initialize();
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: DASHBOARD_ADMIN_EMAIL, password: batch.password }),
    );
    const delivery = JSON.parse(await readFile(join(directory, 'cakeadmin.private.json'), 'utf8'));
    expect(delivery).toEqual({ login: DASHBOARD_ADMIN_LOGIN, password: batch.password });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
