import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import request = require('supertest');
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import { DashboardAccountsService } from '@infra/server/dashboard-access/dashboard-accounts.service';
import { TenantRole } from '@/types/dashboard-account';
import { UnauthorizedException } from '@nestjs/common';
import { DashboardAccountsController } from '@infra/server/dashboard-access/dashboard-accounts.controller';
import { CenterDashboardInterceptor } from '@biz/center-dashboard/center-dashboard.interceptor';
import { CenterDashboardService } from '@biz/center-dashboard/center-dashboard.service';
import { DashboardAccessController } from '@biz/center-dashboard/dashboard-access.controller';
import { ResponseInterceptor } from '@infra/server/response/interceptors/response.interceptor';
import type { INestApplication } from '@nestjs/common';

import { HostingBindingsController } from '@biz/center-dashboard/hosting-bindings.controller';
import { HostingBindingsService } from '@biz/center-dashboard/hosting-bindings.service';
import { HostingBindingsRepository } from '@biz/center-dashboard/hosting-bindings.repository';
import { HostingConfigController } from '@biz/hosting-config/hosting-config.controller';
import { HostingConfigFacadeService } from '@biz/hosting-config/services/hosting-config-facade.service';
import { UserController } from '@biz/user/user.controller';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

let legacyCalls = 0;
@Controller()
class LegacyController {
  @Get('group/list') groups() {
    legacyCalls++;
    return [{ id: 'hq' }, { id: 'own' }];
  }
  @Get([
    'analytics/message-processing-records/:messageId/request',
    'analytics/message-processing-records/:messageId/model-calls',
    'analytics/message-processing-records/:messageId/model-calls/:id',
  ])
  modelRequest() {
    legacyCalls++;
    return { request: { instructions: 'private test fixture' } };
  }
  @Get('analytics/chat-sessions/:chatId/messages') messages() {
    legacyCalls++;
    return { leaked: true };
  }
}

describe('Real HTTP routing preserves HQ and scopes center before old handlers', () => {
  let app: INestApplication;
  const center = { handle: jest.fn() };
  const globalStatus = jest.fn().mockResolvedValue(true);
  const globalToggle = jest.fn().mockResolvedValue({ enabled: false });
  const adminGroupSwitch = jest.fn().mockResolvedValue({ message: '小组开关已保存' });
  const hosting = { sync: jest.fn(), bind: jest.fn() };
  const users = { setTenantHosting: jest.fn(), pauseUser: jest.fn(), resumeUser: jest.fn() };
  const hostingDirectory = {
    directory: jest.fn().mockResolvedValue({ groups: [], tenants: [], checkedAt: null }),
  };
  const operations = {
    list: jest.fn(),
    listTenants: jest.fn(),
    create: jest.fn(),
    resetPassword: jest.fn(),
    disable: jest.fn(),
    restore: jest.fn(),
    deleteLogin: jest.fn(),
    deleteEmptyTenant: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        LegacyController,
        UserController,
        HostingConfigController,
        DashboardAccessController,
        DashboardAccountsController,
        HostingBindingsController,
      ],
      providers: [
        { provide: UserHostingService, useValue: users },
        { provide: HostingBindingsService, useValue: hosting },
        { provide: HostingBindingsRepository, useValue: hostingDirectory },
        {
          provide: HostingConfigFacadeService,
          useValue: {
            getAiReplyStatus: globalStatus,
            toggleAiReply: globalToggle,
            addToBlacklist: adminGroupSwitch,
          },
        },
        DashboardAccessService,
        ApiTokenGuard,
        {
          provide: DashboardAccountsService,
          useValue: {
            ...operations,
            identify: async (token: string) => {
              if (!['henan-one', 'henan-two', 'shanghai', 'hq', 'admin'].includes(token))
                throw new UnauthorizedException();
              return {
                userId: token,
                tenant: { name: token, readsAllTenants: ['hq', 'admin'].includes(token) },
                name: token === 'hq' ? 'cakeadmin' : '测试',
                loginName: token === 'admin' ? 'cakeadmin' : null,
                phone: token === 'admin' ? null : '+12025550118',
                tenantRole:
                  token === 'admin'
                    ? null
                    : token === 'henan-one'
                      ? TenantRole.TenantAdmin
                      : TenantRole.GroupLeader,
                organization: ['hq', 'admin'].includes(token)
                  ? 'headquarters'
                  : token === 'shanghai'
                    ? 'shanghai_recruitment'
                    : 'henan',
              };
            },
          },
        },
        CenterDashboardInterceptor,
        {
          provide: ConfigService,
          useValue: new ConfigService(),
        },
        { provide: CenterDashboardService, useValue: center },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalGuards(app.get(ApiTokenGuard));
    app.useGlobalInterceptors(
      app.get(CenterDashboardInterceptor),
      new ResponseInterceptor(new Reflector()),
    );
    // 整套测试共用监听中的服务，避免逐请求关闭临时服务与 HTTP keep-alive 复用发生竞态。
    await app.listen(0, '127.0.0.1');
  });
  afterAll(() => app.close());
  beforeEach(() => {
    legacyCalls = 0;
    center.handle.mockReset().mockResolvedValue([{ id: 'own' }]);
  });
  it.each([
    ['henan-one', '手机号尾号 0118', TenantRole.TenantAdmin],
    ['henan-two', '手机号尾号 0118', TenantRole.GroupLeader],
    ['admin', 'cakeadmin', null],
  ])('shows the signed-in account for %s', async (token, loginLabel, tenantRole) => {
    const result = await request(app.getHttpServer())
      .get('/dashboard/access')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(result.body.data).toMatchObject({
      userId: token,
      displayName: '测试',
      loginLabel,
      tenantRole,
    });
    expect(result.text).not.toContain('+12025550118');
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it.each(['request', 'model-calls', 'model-calls/7e690820-cd8c-4ed4-941c-e7c096658067'])(
    'keeps %s outside center access',
    async (path) => {
      await request(app.getHttpServer())
        .get(`/analytics/message-processing-records/example/${path}`)
        .set('Authorization', 'Bearer henan-one')
        .expect(403);
      expect(legacyCalls).toBe(0);
    },
  );
  it('same URL returns scoped center rows and unchanged HQ rows', async () => {
    const own = await request(app.getHttpServer())
      .get('/group/list')
      .set('Authorization', 'Bearer henan-one')
      .expect(200);
    expect(own.body.data).toEqual([{ id: 'own' }]);
    expect(own.headers['cache-control']).toBe('no-store');
    expect(legacyCalls).toBe(0);
    const hq = await request(app.getHttpServer())
      .get('/group/list')
      .set('Authorization', 'Bearer hq')
      .expect(200);
    expect(hq.body.data).toEqual([{ id: 'hq' }, { id: 'own' }]);
    expect(hq.headers['cache-control']).toBe('no-store');
    expect(legacyCalls).toBe(1);
  });
  it('scopes Shanghai requests and rejects its staff from account management', async () => {
    const server = app.getHttpServer();
    await request(server).get('/group/list').set('Authorization', 'Bearer shanghai').expect(200);
    expect(center.handle).toHaveBeenCalledWith('groups', expect.anything(), 'shanghai_recruitment');
    await request(server)
      .get('/dashboard/accounts')
      .set('Authorization', 'Bearer shanghai')
      .expect(403);
    expect(legacyCalls).toBe(0);
  });
  it('keeps headquarters reads global and routes both personal group switch actions to the headquarters tenant', async () => {
    const api = request(app.getHttpServer());
    for (const call of [api.post('/config/blacklist'), api.delete('/config/blacklist')]) {
      await call
        .set('Authorization', 'Bearer hq')
        .set('Host', 'cake.test')
        .set('Origin', 'https://cake.test')
        .set('X-Center-Action', 'hosting')
        .send({ id: 'hq', type: 'groupId' })
        .expect(200);
    }
    expect(center.handle).toHaveBeenCalledTimes(2);
    expect(center.handle).toHaveBeenCalledWith('group-switch', expect.anything(), 'headquarters');
    expect(adminGroupSwitch).not.toHaveBeenCalled();
    await api
      .post('/config/blacklist')
      .set('Authorization', 'Bearer admin')
      .send({ id: 'own', type: 'groupId' })
      .expect(200);
    expect(adminGroupSwitch).toHaveBeenCalledTimes(1);
  });
  it('two employees see the same center regardless of source network', async () => {
    for (const token of ['henan-one', 'henan-two']) {
      const response = await request(app.getHttpServer())
        .get('/group/list')
        .query({ all: 'true' })
        .set('Authorization', 'Bearer ' + token)
        .set('X-Real-IP', '203.0.113.1')
        .expect(200);
      expect(response.body.data).toEqual([{ id: 'own' }]);
    }
    await request(app.getHttpServer()).get('/group/list').expect(401);
    expect(legacyCalls).toBe(0);
  });
  it('requires cakeadmin for the hosting directory, sync and group binding', async () => {
    const api = request(app.getHttpServer());
    const id = 'ab3c0191-8036-45b2-8296-b1d42d8dff81';
    const base = '/dashboard/hosting-bindings';
    const selection = { groupId: 'target', previousGroupId: null, previousOwnerId: null };
    const binding = { ...selection, organization: 'henan' };
    for (const token of ['hq', 'henan-one', 'shanghai']) {
      await api
        .get(base)
        .set('Authorization', 'Bearer ' + token)
        .expect(403);
      for (const [path, body] of [
        ['/sync', {}],
        ['/members/' + id, binding],
      ] as const)
        await api
          .post(base + path)
          .set('Authorization', 'Bearer ' + token)
          .send(body)
          .expect(403);
    }
    await api.get(base).set('Authorization', 'Bearer admin').expect(200);
    await api
      .post(base + '/sync')
      .set('Authorization', 'Bearer admin')
      .expect(201);
    await api
      .post(base + '/members/' + id)
      .set('Authorization', 'Bearer admin')
      .send(binding)
      .expect(201);
    expect(hosting.bind).toHaveBeenCalledWith(id, 'henan', selection, 'admin');
  });
  it('only the dedicated administrator can list, provision, reset and disable accounts', async () => {
    const staffId = 'ab3c0191-8036-45b2-8296-b1d42d8dff81';
    const api = request(app.getHttpServer());
    const base = '/dashboard/accounts';
    const account = {
      name: '测试同事',
      organization: 'henan',
      phone: '13900000000',
      password: 'fixture-password',
    };
    const reset = { password: 'fixture-new-password' };
    for (const token of ['henan-one', 'shanghai', 'hq']) {
      for (const req of [
        api.get(base),
        api.get(base + '/organizations'),
        api.delete(base + '/organizations/unused-fixture'),
        api.get(base).query({ organization: 'henan' }),
        api.post(base).send(account),
        api.post(base + '/' + staffId + '/password').send(reset),
        api.post(base + '/' + staffId + '/disable'),
        api.post(base + '/' + staffId + '/restore'),
        api.delete(base + '/' + staffId),
      ]) {
        await req.set('Authorization', 'Bearer ' + token).expect(403);
      }
    }
    expect(Object.values(operations).every((op) => op.mock.calls.length === 0)).toBe(true);
    operations.list.mockResolvedValue({ total: 0, accounts: [] });
    const administrator = 'Bearer admin';
    await api
      .delete(base + '/organizations/unused-fixture')
      .set('Authorization', administrator)
      .expect(200);
    expect(operations.deleteEmptyTenant).toHaveBeenCalledWith('unused-fixture', 'admin');
    await api
      .post(base + '/' + staffId + '/restore')
      .set('Authorization', administrator)
      .expect(201);
    expect(operations.restore).toHaveBeenCalledWith(staffId, 'admin');
    await api
      .delete(base + '/' + staffId)
      .set('Authorization', administrator)
      .expect(200);
    expect(operations.deleteLogin).toHaveBeenCalledWith(staffId, 'admin');
    await api.get(base).set('Authorization', administrator).expect(200);
    expect(operations.list).toHaveBeenCalledWith(1, undefined);
    operations.listTenants.mockResolvedValue({ total: 1, tenants: [] });
    await api
      .get(base + '/organizations')
      .set('Authorization', administrator)
      .expect(200);
    expect(operations.listTenants).toHaveBeenCalledWith(1);
    await api
      .get(base)
      .query({ organization: 'henan', page: 2 })
      .set('Authorization', administrator)
      .expect(200);
    expect(operations.list).toHaveBeenLastCalledWith(2, 'henan');
    await api.get(base).query({ organization: '' }).set('Authorization', administrator).expect(400);
    await api
      .post(base)
      .set('Authorization', administrator)
      .send({ ...account, password: 'tiny' })
      .expect(400);
    await api.post(base).set('Authorization', administrator).send(account).expect(201);
    expect(operations.create).toHaveBeenCalledWith(
      { ...account, phone: '+8613900000000' },
      'admin',
    );
    for (const tenantRole of Object.values(TenantRole)) {
      await api
        .post(base)
        .set('Authorization', administrator)
        .send({ ...account, tenantRole })
        .expect(201);
      expect(operations.create).toHaveBeenLastCalledWith(
        { ...account, phone: '+8613900000000', tenantRole },
        'admin',
      );
    }
    await api
      .post(base)
      .set('Authorization', administrator)
      .send({ ...account, tenantRole: 'system_admin' })
      .expect(400);
    await api
      .post(base + '/' + staffId + '/password')
      .set('Authorization', administrator)
      .send(reset)
      .expect(201);
    expect(operations.resetPassword).toHaveBeenCalledWith(staffId, reset.password, 'admin');
    await api
      .post(base + '/' + staffId + '/disable')
      .set('Authorization', administrator)
      .expect(201);
    expect(operations.disable).toHaveBeenCalledWith(staffId, 'admin');
  });
  it('has no organization transfer route for existing accounts, even for the administrator', async () => {
    await request(app.getHttpServer())
      .patch('/dashboard/accounts/ab3c0191-8036-45b2-8296-b1d42d8dff81/organization')
      .set('Authorization', 'Bearer admin')
      .send({ organization: 'headquarters' })
      .expect(404);
  });
  it('decodes detail identity for scoped lookup, without executing the legacy handler', async () => {
    await request(app.getHttpServer())
      .get('/analytics/chat-sessions/foreign%3Achat/messages')
      .set('Authorization', 'Bearer henan-one')
      .expect(200);
    expect(center.handle).toHaveBeenCalledWith(
      'messages',
      expect.objectContaining({ params: { chatId: 'foreign:chat' } }),
      'henan',
    );
    expect(legacyCalls).toBe(0);
  });
  it('only cakeadmin can read and change the global AI reply switch', async () => {
    const api = request(app.getHttpServer());
    for (const token of ['hq', 'henan-one', 'shanghai']) {
      await api
        .get('/config/ai-reply-status')
        .set('Authorization', 'Bearer ' + token)
        .expect(403);
      await api
        .post('/config/toggle-ai-reply')
        .set('Authorization', 'Bearer ' + token)
        .send({ enabled: false })
        .expect(403);
    }
    expect(globalToggle).not.toHaveBeenCalled();
    expect(globalStatus).not.toHaveBeenCalled();
    await api.get('/config/ai-reply-status').set('Authorization', 'Bearer admin').expect(200);
    await api
      .post('/config/toggle-ai-reply')
      .set('Authorization', 'Bearer admin')
      .send({ enabled: false })
      .expect(200);
    expect(globalToggle).toHaveBeenCalledWith(false);
  });
  it('routes each staff switch with the tenant from the session and retains the platform administrator path', async () => {
    const api = request(app.getHttpServer());
    const toggle = (token: string, enabled: unknown, origin = 'https://cake.test') =>
      api
        .post('/user/users/qa%3Achat/hosting')
        .set('Authorization', 'Bearer ' + token)
        .set('Host', 'cake.test')
        .set('Origin', origin)
        .set('X-Center-Action', 'hosting')
        .send({ enabled, tenantId: 'ignored-client-value' });
    for (const [token, tenant] of [
      ['henan-one', 'henan'],
      ['henan-two', 'henan'],
      ['shanghai', 'shanghai_recruitment'],
      ['hq', 'headquarters'],
    ]) {
      for (const enabled of [false, true]) {
        const result = await toggle(token, enabled).expect(200);
        expect(result.body.data).toMatchObject({ chatId: 'qa:chat', hostingEnabled: enabled });
        expect(users.setTenantHosting).toHaveBeenLastCalledWith(tenant, 'qa:chat', enabled);
      }
    }
    await toggle('henan-one', 'false').expect(400);
    await toggle('henan-two', false, 'https://elsewhere.test').expect(403);
    await api
      .post('/user/users/qa%3Achat/resume')
      .set('Authorization', 'Bearer henan-one')
      .expect(403);
    expect(users.setTenantHosting).toHaveBeenCalledTimes(8);
    expect(users.pauseUser).not.toHaveBeenCalled();
    expect(users.resumeUser).not.toHaveBeenCalled();
    await toggle('admin', true).expect(200);
    expect(users.resumeUser).toHaveBeenCalledWith('qa:chat');
  });
  it('blocks global switch reads/writes and cross-origin mutations', async () => {
    await request(app.getHttpServer())
      .get('/config/ai-reply-status')
      .set('Authorization', 'Bearer henan-one')
      .expect(403);
    await request(app.getHttpServer())
      .post('/config/toggle-ai-reply')
      .set('Authorization', 'Bearer henan-one')
      .send({ enabled: true })
      .expect(403);
    await request(app.getHttpServer())
      .post('/config/blacklist')
      .set('Authorization', 'Bearer henan-one')
      .set('Host', 'cake.test')
      .set('Origin', 'https://foreign.test')
      .set('X-Center-Action', 'hosting')
      .send({ id: 'own', type: 'groupId' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/config/blacklist')
      .set('Authorization', 'Bearer henan-one')
      .set('Host', 'cake.test')
      .set('Origin', 'https://cake.test')
      .set('X-Center-Action', 'hosting')
      .send({ id: 'own', type: 'groupId' })
      .expect(200);
    expect(center.handle).toHaveBeenCalledTimes(1);
    expect(legacyCalls).toBe(0);
  });
});
