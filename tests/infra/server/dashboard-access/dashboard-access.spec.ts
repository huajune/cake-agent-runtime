import { DashboardAccountsService } from '@infra/server/dashboard-access/dashboard-accounts.service';
import type { SupabaseService } from '@infra/supabase/supabase.service';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import {
  dashboardLoginIdentity,
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
  const updateSingle = jest.fn();
  const update = jest.fn(() => ({ eq: () => ({ select: () => ({ maybeSingle: updateSingle }) }) }));
  const getUser = jest.fn();
  const admin = { createUser: jest.fn(), updateUserById: jest.fn() };
  const service = new DashboardAccountsService({
    getSupabaseClient: () => ({
      auth: { getUser, admin },
      from: (table: string) => ({
        select: () => ({
          eq: () => ({ maybeSingle: table === 'tenants' ? tenantSingle : single }),
        }),
        update,
      }),
    }),
  } as unknown as SupabaseService);
  beforeEach(() => {
    jest.clearAllMocks();
    tenantSingle.mockResolvedValue({ data: { id: 'henan' } });
    getUser.mockResolvedValue({ data: { user: authUser }, error: null });
    single.mockResolvedValue({ data: row, error: null });
  });
  it('counts all accounts per registered tenant and pages members within the selected tenant', async () => {
    const urls: URL[] = [];
    const client = createClient('https://accounts.example.invalid', 'test-key', {
      global: {
        fetch: async (input) => {
          const url = new URL(input.toString());
          urls.push(url);
          const tenants = url.pathname.endsWith('/tenants');
          const body = tenants
            ? [
                { id: 'new-team', name: '同名组织', members: [{ count: 51 }] },
                { id: 'empty-team', name: '同名组织', members: [{ count: 0 }] },
              ]
            : [{ ...row, organization: 'new-team' }];
          return new Response(JSON.stringify(body), {
            headers: { 'Content-Range': tenants ? '0-1/2' : '50-50/51' },
          });
        },
      },
    });
    const roster = new DashboardAccountsService({
      getSupabaseClient: () => client,
    } as SupabaseService);
    await expect(roster.listTenants(1)).resolves.toEqual({
      total: 2,
      tenants: [
        { id: 'new-team', name: '同名组织', accountCount: 51 },
        { id: 'empty-team', name: '同名组织', accountCount: 0 },
      ],
    });
    await expect(roster.list(2, 'new-team')).resolves.toMatchObject({ total: 51 });
    expect(urls[0].searchParams.get('select')).toContain('dashboard_accounts_tenant_fk(count)');
    const filter = urls[1].searchParams;
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
    expect(getUser).toHaveBeenCalledTimes(1);
    single.mockResolvedValue({ data: { ...row, disabled: true }, error: null });
    await expect(access.authenticate({} as Request, 'session')).rejects.toMatchObject({
      status: 403,
    });
    expect(access.requireAccount(first)).toEqual(row);
  });
  it.each([
    null,
    { ...row, phone: '+12025550129' },
    { ...row, organization: 'unknown', tenant: null },
  ])('denies unmapped accounts', async (entry) => {
    single.mockResolvedValue({ data: entry });
    await expect(service.identify('session')).rejects.toMatchObject({ status: 403 });
  });
  it('accepts a newly registered supplier and rejects a missing organization before provisioning', async () => {
    const supplier = { ...row, organization: 'supplier-4', tenant: { name: '新供应商' } };
    single.mockResolvedValue({ data: supplier });
    await expect(service.identify('session')).resolves.toEqual(supplier);
    tenantSingle.mockResolvedValue({ data: null });
    await expect(
      service.create({ ...supplier, password: 'fixture-pass' }, 'hq'),
    ).rejects.toMatchObject({ status: 400 });
    expect(admin.createUser).not.toHaveBeenCalled();
  });
  it('accepts the dedicated confirmed Auth identity only with its bound account row', async () => {
    const identity = {
      id: 'admin-uuid',
      email: 'cakeadmin@dashboard.cake.invalid',
      email_confirmed_at: 'today',
      app_metadata: { cake_dashboard_account: { login_name: 'cakeadmin' } },
    };
    const administrator = {
      ...row,
      userId: identity.id,
      phone: null,
      loginName: 'cakeadmin',
      organization: 'headquarters',
    };
    single.mockResolvedValue({ data: administrator });
    getUser.mockResolvedValue({ data: { user: identity } });
    await expect(service.identify('session')).resolves.toEqual(administrator);
    for (const user of [
      { ...identity, email_confirmed_at: null },
      { ...identity, email: 'other@example.invalid' },
      { ...identity, app_metadata: {}, user_metadata: identity.app_metadata },
      authUser,
    ]) {
      getUser.mockResolvedValue({ data: { user } });
      await expect(service.identify('session')).rejects.toMatchObject({ status: 403 });
    }
    getUser.mockResolvedValue({ data: { user: identity } });
    single.mockResolvedValue({ data: { ...administrator, disabled: true } });
    await expect(service.identify('session')).rejects.toMatchObject({ status: 403 });
    single.mockResolvedValue({ data: { ...administrator, loginName: null } });
    await expect(service.identify('session')).rejects.toMatchObject({ status: 403 });
  });
  it('fails closed during a membership outage', async () => {
    single.mockResolvedValue({ error: { message: 'offline' } });
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
  it('bans only a managed Auth identity and checks its synchronized status', async () => {
    admin.updateUserById.mockResolvedValue({ error: null });
    single
      .mockResolvedValueOnce({ data: row })
      .mockResolvedValueOnce({ data: { ...row, disabled: true } });
    await service.update(row.userId, { disabled: true }, 'hq');
    expect(admin.updateUserById).toHaveBeenCalledWith(row.userId, { ban_duration: '876000h' });
    single.mockResolvedValueOnce({ data: null });
    await expect(service.update('unknown', { disabled: true }, 'hq')).rejects.toMatchObject({
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
  it('does not disable or change the acting headquarters account', async () => {
    await expect(service.update('hq', { disabled: true }, 'hq')).rejects.toMatchObject({
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
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
});
