import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import request = require('supertest');
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import { DashboardAccountsService } from '@infra/server/dashboard-access/dashboard-accounts.service';
import { UnauthorizedException } from '@nestjs/common';
import { DashboardAccountsController } from '@infra/server/dashboard-access/dashboard-accounts.controller';
import { CenterDashboardInterceptor } from '@biz/center-dashboard/center-dashboard.interceptor';
import { CenterDashboardService } from '@biz/center-dashboard/center-dashboard.service';
import { ResponseInterceptor } from '@infra/server/response/interceptors/response.interceptor';
import type { INestApplication } from '@nestjs/common';

import { HostingBindingsController } from '@biz/center-dashboard/hosting-bindings.controller';
import { HostingBindingsService } from '@biz/center-dashboard/hosting-bindings.service';
import { HostingBindingsRepository } from '@biz/center-dashboard/hosting-bindings.repository';
import { HostingConfigController } from '@biz/hosting-config/hosting-config.controller';
import { HostingConfigFacadeService } from '@biz/hosting-config/services/hosting-config-facade.service';

let legacyCalls = 0;
@Controller()
class LegacyController {
  @Get('group/list') groups() {
    legacyCalls++;
    return [{ id: 'hq' }, { id: 'own' }];
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
  const hosting = { sync: jest.fn(), bind: jest.fn(), confirm: jest.fn() };
  const hostingDirectory = {
    directory: jest.fn().mockResolvedValue({ groups: [], handovers: [] }),
  };
  const operations = {
    list: jest.fn(),
    create: jest.fn(),
    resetPassword: jest.fn(),
    update: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        LegacyController,
        HostingConfigController,
        DashboardAccountsController,
        HostingBindingsController,
      ],
      providers: [
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
  it('requires cakeadmin for the hosting directory, sync, binding and actual-time confirmation', async () => {
    const api = request(app.getHttpServer());
    const id = 'ab3c0191-8036-45b2-8296-b1d42d8dff81';
    const base = '/dashboard/hosting-bindings';
    const selection = { groupId: 'target', previousGroupId: null, previousOwnerId: null };
    const binding = { ...selection, organization: 'henan' };
    const handover = { targetGroupId: 'target', effectiveAt: '2026-11-20T08:30:00.000Z' };
    for (const token of ['hq', 'henan-one', 'shanghai']) {
      await api
        .get(base)
        .set('Authorization', 'Bearer ' + token)
        .expect(403);
      for (const [path, body] of [
        ['/sync', {}],
        ['/members/' + id, binding],
        ['/handovers/' + id, handover],
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
    await api
      .post(base + '/handovers/' + id)
      .set('Authorization', 'Bearer admin')
      .send(handover)
      .expect(201);
    expect(hosting.confirm).toHaveBeenCalledWith(id, 'target', handover.effectiveAt, 'admin');
    await api
      .post(base + '/handovers/' + id)
      .set('Authorization', 'Bearer admin')
      .send({ ...handover, effectiveAt: 'yesterday' })
      .expect(400);
  });
  it('only the dedicated administrator can list, provision, reset, disable and transfer accounts', async () => {
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
        api.post(base).send(account),
        api.post(base + '/' + staffId + '/password').send(reset),
        api.post(base + '/' + staffId + '/disable'),
        api.patch(base + '/' + staffId + '/organization').send({ organization: 'headquarters' }),
      ]) {
        await req.set('Authorization', 'Bearer ' + token).expect(403);
      }
    }
    expect(Object.values(operations).every((op) => op.mock.calls.length === 0)).toBe(true);
    operations.list.mockResolvedValue({ total: 0, accounts: [] });
    const administrator = 'Bearer admin';
    await api.get(base).set('Authorization', administrator).expect(200);
    expect(operations.list).toHaveBeenCalledWith(1);
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
    await api
      .post(base + '/' + staffId + '/password')
      .set('Authorization', administrator)
      .send(reset)
      .expect(201);
    expect(operations.resetPassword).toHaveBeenCalledWith(staffId, reset.password, 'admin');
    await api
      .patch(base + '/' + staffId + '/organization')
      .set('Authorization', administrator)
      .send({ organization: 'headquarters' })
      .expect(200);
    expect(operations.update).toHaveBeenCalledWith(
      staffId,
      { organization: 'headquarters' },
      'admin',
    );
    await api
      .post(base + '/' + staffId + '/disable')
      .set('Authorization', administrator)
      .expect(201);
    expect(operations.update).toHaveBeenCalledWith(staffId, { disabled: true }, 'admin');
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
