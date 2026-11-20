import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateStaffAccounts } from '../../src/cli/dashboard-onboarding';

it('开户中断后沿用已开户成员的密码，只向总部交付本批新账号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-onboarding-'));
  const members = ['001', '002', '003', '004'].map((suffix) => ({
    name: '测试成员' + suffix,
    phone: '+12025550' + suffix,
    groupId: 'group-' + suffix,
    organization: 'henan' as const,
    feishuOpenId: null,
  }));
  const rows = new Map(
    members.map((member, index) => [
      member.phone,
      {
        ...member,
        hosting_group_id: member.groupId,
        organization: 'henan',
        disabled: index === 3,
        user_id: index === 2 ? 'existing' : null,
      },
    ]),
  );
  const users = new Map([
    ['existing', { phone: members[2].phone, phone_confirmed_at: 'confirmed', app_metadata: {} }],
  ]);
  let interrupted = true;
  const createUser = jest.fn(async ({ phone, app_metadata }) => {
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
    await expect(current()).rejects.toThrow('开户未完成');
    const working = join(dir, 'credentials.work.json');
    const original = JSON.parse(await readFile(working, 'utf8'));
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
    expect(createUser.mock.calls.map(([input]) => input.phone)).toEqual([
      members[0].phone,
      members[1].phone,
      members[1].phone,
    ]);
    expect((await stat(handoff)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, 'complete.json'), 'utf8'))).toMatchObject({
      created: 2,
      existing: 1,
      disabled: 1,
    });
    await expect(stat(working)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
