import { DashboardAccountsService } from '@infra/server/dashboard-access/dashboard-accounts.service';
import type { SupabaseService } from '@infra/supabase/supabase.service';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import {
  dashboardLoginIdentity,
  formatDashboardPhone,
  normalizeDashboardPhone,
  TenantRole,
} from '@/types/dashboard-account';
import type { Request } from 'express';
import { createClient } from '@supabase/supabase-js';

describe('staff accounts and organization authority', () => {
  const authUser = { id: 'employee', phone: '12025550127', phone_confirmed_at: 'today' };
  const row = {
    userId: authUser.id,
    phone: '+12025550127',
    name: '同事',
    organization: 'henan',
    tenant: { name: '河南自招中心' },
    disabled: false,
  };
  const single = jest.fn();
  const tenantSingle = jest.fn();
  const identityResult = jest.fn();
  const withBearer = jest.fn(() => identityResult());
  const rpc = jest.fn();
  const admin = { createUser: jest.fn(), updateUserById: jest.fn() };
  const service = new DashboardAccountsService({
    getSupabaseClient: () => ({
      auth: { admin },
      rpc: (name: string, args?: unknown) =>
        name === 'current_dashboard_account' ? { setHeader: withBearer } : rpc(name, args),
      from: (table: string) => ({
        select: () => ({
          eq: () => ({ maybeSingle: table === 'tenants' ? tenantSingle : single }),
        }),
      }),
    }),
  } as unknown as SupabaseService);
  beforeEach(() => {
    jest.clearAllMocks();
    tenantSingle.mockResolvedValue({ data: { id: 'henan' } });
    identityResult.mockResolvedValue({ data: row, error: null, status: 200 });
    single.mockResolvedValue({ data: row, error: null });
  });
  it('counts and paginates registered logins, keeping organizations with only member profiles', async () => {
    const urls: URL[] = [];
    const client = createClient('https://accounts.example.invalid', 'test-key', {
      global: {
        fetch: async (input) => {
          const url = new URL(input.toString());
          urls.push(url);
          const tenants = url.pathname.endsWith('/tenants');
          const body = tenants
            ? [
                {
                  id: 'new-team',
                  name: '同名组织',
                  members: [{ count: 52 }],
                  accounts: [{ count: 51 }],
                },
                {
                  id: 'profile-only',
                  name: '成员组',
                  members: [{ count: 1 }],
                  accounts: [{ count: 0 }],
                },
                {
                  id: 'empty-team',
                  name: '同名组织',
                  members: [{ count: 0 }],
                  accounts: [{ count: 0 }],
                },
              ]
            : [{ ...row, organization: 'new-team' }];
          return new Response(JSON.stringify(body), {
            headers: { 'Content-Range': tenants ? '0-2/3' : '50-50/51' },
          });
        },
      },
    });
    const roster = new DashboardAccountsService({
      getSupabaseClient: () => client,
    } as SupabaseService);
    await expect(roster.listTenants(1)).resolves.toEqual({
      total: 3,
      tenants: [
        { id: 'new-team', name: '同名组织', accountCount: 51, hasMembers: true },
        { id: 'profile-only', name: '成员组', accountCount: 0, hasMembers: true },
        { id: 'empty-team', name: '同名组织', accountCount: 0, hasMembers: false },
      ],
    });
    await expect(roster.list(2, 'new-team')).resolves.toMatchObject({ total: 51 });
    expect(urls[0].searchParams.get('select')).toContain(
      'members:tenant_members!tenant_members_tenant_fk(count)',
    );
    expect(urls[0].searchParams.get('accounts.user_id')).toBe('not.is.null');
    expect(urls[1].pathname).toBe('/rest/v1/tenant_members');
    const filter = urls[1].searchParams;
    expect(filter.get('user_id')).toBe('not.is.null');
    expect(filter.has('disabled')).toBe(false);
    expect(filter.get('organization')).toBe('eq.new-team');
    expect(filter.get('offset')).toBe('50');
    expect(filter.get('limit')).toBe('50');
    expect(filter.get('order')).toMatch(/,id\.asc$/);
  });
  it('checks account status anew for each request, only reuses the identity within one request', async () => {
    const access = new DashboardAccessService(service);
    const first = {} as Request;
    await access.authenticate(first, 'session');
    await access.authenticate(first, 'session');
    expect(withBearer).toHaveBeenCalledTimes(1);
    expect(withBearer).toHaveBeenCalledWith('Authorization', 'Bearer session');
    identityResult.mockResolvedValue({ data: null, error: null, status: 200 });
    await expect(access.authenticate({} as Request, 'session')).rejects.toMatchObject({
      status: 403,
    });
    expect(access.requireAccount(first)).toEqual(row);
  });
  it.each([401, 403])('requires sign-in when the gateway rejects the JWT (%i)', async (status) => {
    identityResult.mockResolvedValue({ data: null, error: { message: 'rejected' }, status });
    await expect(service.identify('session')).rejects.toMatchObject({ status: 401 });
  });
  it('accepts a newly registered supplier and rejects a missing organization before provisioning', async () => {
    const supplier = { ...row, organization: 'supplier-4', tenant: { name: '新供应商' } };
    identityResult.mockResolvedValue({ data: supplier, status: 200 });
    await expect(service.identify('session')).resolves.toEqual(supplier);
    tenantSingle.mockResolvedValue({ data: null });
    await expect(
      service.create({ ...supplier, password: 'fixture-pass' }, 'hq'),
    ).rejects.toMatchObject({ status: 400 });
    expect(admin.createUser).not.toHaveBeenCalled();
  });
  it('fails closed during a membership outage', async () => {
    identityResult.mockResolvedValue({ status: 503, error: { message: 'offline' } });
    await expect(service.identify('session')).rejects.toMatchObject({ status: 503 });
  });
  it('provisions the Auth user with a password and trusted organization data', async () => {
    single.mockResolvedValueOnce({ data: { ...row, userId: null } });
    admin.createUser.mockResolvedValue({ data: { user: authUser } });
    await service.create(
      { name: row.name, phone: row.phone, organization: 'henan', password: 'test-only-pass' },
      'hq',
    );
    expect(admin.createUser).toHaveBeenCalledWith({
      phone: row.phone,
      password: 'test-only-pass',
      phone_confirm: true,
      app_metadata: { cake_dashboard_account: { name: row.name, organization: 'henan' } },
    });
  });
  it.each(Object.values(TenantRole))(
    'provisions %s and only binds a selected group for group leaders',
    async (tenantRole) => {
      const hostingBinding = { groupId: 'group-1', previousGroupId: null, previousOwnerId: null };
      single
        .mockResolvedValueOnce({ data: null })
        .mockResolvedValueOnce({ data: { ...row, tenantRole } });
      admin.createUser.mockResolvedValue({ data: { user: authUser } });
      await service.create(
        { ...row, tenantRole, hostingBinding, password: 'fixture-pass' },
        'admin',
      );
      expect(admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          app_metadata: {
            cake_dashboard_account: {
              name: row.name,
              organization: row.organization,
              tenant_role: tenantRole,
              ...(tenantRole === TenantRole.GroupLeader && {
                hosting_binding: { ...hostingBinding, actor: 'admin' },
              }),
            },
          },
        }),
      );
    },
  );
  it('preserves the hosting assignment of a pending administrator when an older caller omits the role', async () => {
    const pending = {
      ...row,
      userId: null,
      tenantRole: TenantRole.TenantAdmin,
      hostingGroupId: 'existing',
    };
    single
      .mockResolvedValueOnce({ data: pending })
      .mockResolvedValueOnce({ data: { ...pending, userId: authUser.id } });
    admin.createUser.mockResolvedValue({ data: { user: authUser } });
    await service.create(
      {
        ...row,
        password: 'fixture-pass',
        memberId: 'member',
        hostingBinding: { groupId: 'new', previousGroupId: 'existing', previousOwnerId: null },
      },
      'admin',
    );
    expect(admin.createUser.mock.calls[0][0].app_metadata.cake_dashboard_account).toEqual({
      name: row.name,
      organization: row.organization,
      member_id: 'member',
    });
  });
  it('blocks duplicate and conflicting roster entries before contacting Auth', async () => {
    const input = {
      name: row.name,
      phone: row.phone,
      organization: 'henan' as const,
      password: 'fixture-pass',
    };
    await expect(service.create(input, 'hq')).rejects.toMatchObject({ status: 409 });
    single.mockResolvedValueOnce({ data: { ...row, userId: null, organization: 'headquarters' } });
    await expect(service.create(input, 'hq')).rejects.toMatchObject({ status: 409 });
    expect(admin.createUser).not.toHaveBeenCalled();
  });
  it('registers a cancelled login only for its matching member profile', async () => {
    const cancelled = { ...row, userId: null, disabled: true, memberId: 'original-member' };
    single.mockResolvedValueOnce({ data: cancelled });
    await expect(
      service.create({ ...row, name: '其他同事', password: 'fixture-pass' }, 'hq'),
    ).rejects.toMatchObject({ status: 409 });
    expect(admin.createUser).not.toHaveBeenCalled();
    single.mockResolvedValueOnce({ data: cancelled }).mockResolvedValueOnce({ data: row });
    admin.createUser.mockResolvedValue({ data: { user: authUser } });
    await service.create({ ...row, password: 'new-fixture-pass' }, 'hq');
    expect(admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        app_metadata: {
          cake_dashboard_account: {
            name: row.name,
            organization: row.organization,
            member_id: cancelled.memberId,
          },
        },
      }),
    );
  });
  it('bans only a managed Auth identity and checks its synchronized status', async () => {
    admin.updateUserById.mockResolvedValue({ error: null });
    single
      .mockResolvedValueOnce({ data: row })
      .mockResolvedValueOnce({ data: { ...row, disabled: true } });
    await service.disable(row.userId, 'hq');
    expect(admin.updateUserById).toHaveBeenCalledWith(row.userId, { ban_duration: '876000h' });
    single.mockResolvedValueOnce({ data: null });
    await expect(service.disable('unknown', 'hq')).rejects.toMatchObject({
      status: 404,
    });
    expect(admin.updateUserById).toHaveBeenCalledTimes(1);
  });
  it('limits password reset to an active Cake account', async () => {
    admin.updateUserById.mockResolvedValue({ error: null });
    await service.resetPassword(authUser.id, 'test-new-pass', 'hq');
    expect(admin.updateUserById).toHaveBeenCalledWith(authUser.id, { password: 'test-new-pass' });
    single.mockResolvedValue({ data: null });
    await expect(service.resetPassword('unmanaged', 'test-new-pass', 'hq')).rejects.toMatchObject({
      status: 404,
    });
    expect(admin.updateUserById).toHaveBeenCalledTimes(1);
  });
  it('does not disable the acting administrator', async () => {
    await expect(service.disable('hq', 'hq')).rejects.toMatchObject({
      status: 409,
    });
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });
  it('restores a disabled employee with the existing password', async () => {
    admin.updateUserById.mockResolvedValue({ error: null });
    single
      .mockResolvedValueOnce({ data: { ...row, disabled: true } })
      .mockResolvedValueOnce({ data: row });
    await service.restore(row.userId, 'hq');
    expect(admin.updateUserById).toHaveBeenCalledWith(row.userId, { ban_duration: 'none' });
  });
  it('reports referenced organizations and active employee logins as conflicts', async () => {
    rpc.mockResolvedValueOnce({ error: { code: '23503' } });
    await expect(service.deleteEmptyTenant('used-fixture', 'hq')).rejects.toMatchObject({
      status: 409,
    });
    expect(rpc).toHaveBeenLastCalledWith('delete_empty_tenant', { p_tenant_id: 'used-fixture' });
    rpc.mockResolvedValueOnce({ error: { code: '23514' } });
    await expect(service.deleteLogin(row.userId, 'hq')).rejects.toMatchObject({ status: 409 });
    expect(rpc).toHaveBeenLastCalledWith('delete_disabled_dashboard_login', {
      p_user_id: row.userId,
    });
    await expect(service.deleteLogin('hq', 'hq')).rejects.toMatchObject({ status: 409 });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('normalizes mainland and international login names', () => {
    expect(normalizeDashboardPhone(' 13900000000 ')).toBe('+8613900000000');
    expect(normalizeDashboardPhone(row.phone)).toBe(row.phone);
    expect(normalizeDashboardPhone('bad')).toBeNull();
    expect(dashboardLoginIdentity(' cakeadmin ')).toEqual({
      email: 'cakeadmin@dashboard.cake.invalid',
    });
    expect(dashboardLoginIdentity('13900000000')).toEqual({ phone: '+8613900000000' });
    expect(dashboardLoginIdentity('other')).toBeNull();
    expect(dashboardLoginIdentity('cakeadmin@dashboard.cake.invalid')).toBeNull();
  });

  it('displays mainland mobile numbers locally while preserving each login identity', () => {
    for (const [stored, displayed] of [
      ['+8613900000000', '13900000000'],
      ['+12025550127', '+12025550127'],
      ['+861088888888', '+861088888888'],
    ]) {
      expect(formatDashboardPhone(stored)).toBe(displayed);
      expect(dashboardLoginIdentity(displayed)).toEqual({ phone: stored });
    }
    expect(formatDashboardPhone('13900000000')).toBe('13900000000');
    expect(formatDashboardPhone(null)).toBeNull();
    expect(formatDashboardPhone(undefined)).toBeNull();
  });
});
