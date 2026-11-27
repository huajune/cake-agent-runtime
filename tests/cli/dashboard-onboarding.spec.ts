import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminUserAttributes, SupabaseClient } from '@supabase/supabase-js';
import { activateStaffAccounts } from '../../src/cli/dashboard-onboarding';
import { TenantRole } from '../../src/types/dashboard-account';

it.each(['自动生成', '预先准备'])('%s密码的开户批次可在中断后原样交付', async (source) => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-onboarding-'));
  const members = ['001', '002', '003', '004'].map((suffix) => ({
    name: '测试成员' + suffix,
    phone: '+12025550' + suffix,
    groupId: 'group-' + suffix,
    organization: 'henan' as const,
    ...(suffix === '001' && { tenantRole: TenantRole.TenantAdmin }),
    feishuOpenId: null,
  }));
  const rows = new Map(
    members.map((member, index) => [
      member.phone,
      {
        ...member,
        hosting_group_id: member.groupId,
        organization: 'henan',
        tenant_role: member.tenantRole ?? TenantRole.GroupLeader,
        disabled: index === 3,
        user_id: index === 2 ? 'existing' : null,
      },
    ]),
  );
  const users = new Map([
    ['existing', { phone: members[2].phone, phone_confirmed_at: 'confirmed', app_metadata: {} }],
  ]);
  let interrupted = true;
  const createUser = jest.fn(async ({ phone, app_metadata }: AdminUserAttributes) => {
    if (phone === members[1].phone && interrupted) {
      interrupted = false;
      return { error: { code: 'temporary_error' } };
    }
    rows.get(phone).user_id = phone;
    users.set(phone, { phone, app_metadata, phone_confirmed_at: 'confirmed' });
    return { error: null };
  });
  const client = {
    rpc: jest.fn().mockResolvedValue({ error: null }),
    from: () => ({
      select: () => ({
        eq: (_key: string, phone: string) => ({
          single: async () => ({ data: rows.get(phone), error: null }),
        }),
      }),
    }),
    auth: {
      admin: {
        createUser,
        getUserById: async (id: string) => ({ data: { user: users.get(id) }, error: null }),
      },
    },
  } as unknown as SupabaseClient;
  const current = () => activateStaffAccounts(client, dir, members, 'fixture-batch');
  try {
    const working = join(dir, 'credentials.work.json');
    const prepared = ['01234567', 'legacy-password-'.repeat(2), '23456789', '34567890'];
    if (source === '预先准备') {
      await writeFile(
        working,
        JSON.stringify({
          fingerprint: 'fixture-batch',
          batchId: '10000000-0000-4000-8000-000000000001',
          passwords: Object.fromEntries(members.map((member, i) => [member.phone, prepared[i]])),
        }),
        { mode: 0o600 },
      );
    }
    await expect(current()).rejects.toThrow('开户未完成');
    const original = JSON.parse(await readFile(working, 'utf8'));
    const passwords = members.map((member) => original.passwords[member.phone]);
    if (source === '自动生成') {
      expect(passwords).toEqual(members.map(() => expect.stringMatching(/^\d{8}$/)));
      expect(new Set(passwords).size).toBe(members.length);
    } else {
      expect(passwords).toEqual(prepared);
    }
    await expect(stat(join(dir, 'complete.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(activateStaffAccounts(client, dir, members, 'different-batch')).rejects.toThrow(
      '批次',
    );
    expect(client.rpc).toHaveBeenCalledTimes(1);
    await current();
    const handoff = join(dir, 'handoff.private.json');
    const result = JSON.parse(await readFile(handoff, 'utf8'));
    expect(result.members).toEqual(
      members.slice(0, 2).map((member) => ({
        ...member,
        password: original.passwords[member.phone],
      })),
    );
    expect(new Set(result.members.map((member) => member.password)).size).toBe(2);
    expect(createUser.mock.calls[0][0].app_metadata).toMatchObject({
      cake_dashboard_account: { tenant_role: TenantRole.TenantAdmin },
    });
    expect(createUser.mock.calls.map(([input]) => input.phone)).toEqual([
      members[0].phone,
      members[1].phone,
      members[1].phone,
    ]);
    expect(createUser.mock.calls.map(([input]) => input.password)).toEqual([
      passwords[0],
      passwords[1],
      passwords[1],
    ]);
    expect((await stat(handoff)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, 'complete.json'), 'utf8'))).toMatchObject({
      created: 2,
      existing: 1,
      disabled: 0,
      cancelled: 1,
    });
    await expect(stat(working)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
