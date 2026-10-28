import { Controller, Delete, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import request = require('supertest');
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { DashboardAccessGuard } from '@infra/server/dashboard-access/dashboard-access.guard';
import { CenterDashboardInterceptor } from '@biz/center-dashboard/center-dashboard.interceptor';
import { CenterDashboardService } from '@biz/center-dashboard/center-dashboard.service';
import { ResponseInterceptor } from '@infra/server/response/interceptors/response.interceptor';
import type { INestApplication } from '@nestjs/common';

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
  @Get('config/ai-reply-status') global() {
    legacyCalls++;
    return { enabled: true };
  }
  @Post('config/toggle-ai-reply') toggle() {
    legacyCalls++;
    return { enabled: false };
  }
  @Post('config/blacklist') block() {
    legacyCalls++;
    return {};
  }
  @Delete('config/blacklist') unblock() {
    legacyCalls++;
    return {};
  }
}

describe('Real HTTP routing preserves HQ and scopes center before old handlers', () => {
  let app: INestApplication;
  const center = { handle: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [LegacyController],
      providers: [
        DashboardAccessService,
        DashboardAccessGuard,
        CenterDashboardInterceptor,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            HENAN_DASHBOARD_IPS: '1.193.23.48',
            DASHBOARD_TRUSTED_PROXY_IPS: '127.0.0.1,::1',
          }),
        },
        { provide: CenterDashboardService, useValue: center },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalGuards(app.get(DashboardAccessGuard));
    app.useGlobalInterceptors(
      app.get(CenterDashboardInterceptor),
      new ResponseInterceptor(new Reflector()),
    );
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    legacyCalls = 0;
    center.handle.mockReset().mockResolvedValue([{ id: 'own' }]);
  });
  it('same URL returns scoped center rows and unchanged HQ rows', async () => {
    const own = await request(app.getHttpServer())
      .get('/group/list')
      .set('X-Real-IP', '1.193.23.48')
      .expect(200);
    expect(own.body.data).toEqual([{ id: 'own' }]);
    expect(own.headers['cache-control']).toBe('no-store');
    expect(legacyCalls).toBe(0);
    const hq = await request(app.getHttpServer())
      .get('/group/list')
      .set('X-Real-IP', '203.0.113.1')
      .expect(200);
    expect(hq.body.data).toEqual([{ id: 'hq' }, { id: 'own' }]);
    expect(hq.headers['cache-control']).toBe('no-store');
    expect(legacyCalls).toBe(1);
  });
  it('decodes detail identity for scoped lookup, without executing the legacy handler', async () => {
    await request(app.getHttpServer())
      .get('/analytics/chat-sessions/foreign%3Achat/messages')
      .set('X-Real-IP', '1.193.23.48')
      .expect(200);
    expect(center.handle).toHaveBeenCalledWith(
      'messages',
      expect.objectContaining({ params: { chatId: 'foreign:chat' } }),
    );
    expect(legacyCalls).toBe(0);
  });
  it('blocks global switch reads/writes and cross-origin mutations', async () => {
    await request(app.getHttpServer())
      .get('/config/ai-reply-status')
      .set('X-Real-IP', '1.193.23.48')
      .expect(403);
    await request(app.getHttpServer())
      .post('/config/toggle-ai-reply')
      .set('X-Real-IP', '1.193.23.48')
      .send({ enabled: true })
      .expect(403);
    await request(app.getHttpServer())
      .post('/config/blacklist')
      .set('X-Real-IP', '1.193.23.48')
      .set('Host', 'cake.test')
      .set('Origin', 'https://foreign.test')
      .set('X-Center-Action', 'hosting')
      .send({ id: 'own', type: 'groupId' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/config/blacklist')
      .set('X-Real-IP', '1.193.23.48')
      .set('Host', 'cake.test')
      .set('Origin', 'https://cake.test')
      .set('X-Center-Action', 'hosting')
      .send({ id: 'own', type: 'groupId' })
      .expect(201);
    expect(center.handle).toHaveBeenCalledTimes(1);
    expect(legacyCalls).toBe(0);
  });
});
