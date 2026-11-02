import { Controller, Get, Post } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import request = require('supertest');
import { DashboardAccessModule } from '@infra/server/dashboard-access/dashboard-access.module';
import { configureDashboardHttpAccess } from '@infra/server/dashboard-access/dashboard-http-access';
import { Public } from '@infra/server/response/decorators/api-response.decorator';

@Public()
@Controller()
class AccessTestController {
  @Get('strategy')
  strategy() {
    return { headquarters: true };
  }

  @Get('group/list')
  groups() {
    return { scopedRoute: true };
  }

  @Get('agent/health')
  health() {
    return { healthy: true };
  }

  @Post(['message', 'message/sent-result', 'message/sentResult', 'new-customer'])
  callback() {
    return { acknowledged: true };
  }

  @Post('message/send')
  send() {
    return { mustStayPrivate: true };
  }
}

describe('Dashboard HTTP source allowlist', () => {
  let app: NestExpressApplication;
  let publicPath: string;

  beforeAll(async () => {
    publicPath = mkdtempSync(join(tmpdir(), 'cake-access-'));
    mkdirSync(join(publicPath, 'web', 'assets'), { recursive: true });
    writeFileSync(join(publicPath, 'web', 'index.html'), 'dashboard HTML');
    writeFileSync(join(publicPath, 'web', 'assets', 'app.js'), 'dashboard JS');
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DashboardAccessModule,
      ],
      controllers: [AccessTestController],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          NODE_ENV: 'production',
          HEADQUARTERS_DASHBOARD_IPS: '203.0.113.4',
          HENAN_DASHBOARD_IPS: '1.193.23.48',
          DASHBOARD_TRUSTED_PROXY_IPS: '127.0.0.1,::1',
        }),
      )
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureDashboardHttpAccess(app, publicPath);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (publicPath) rmSync(publicPath, { recursive: true, force: true });
  });

  it.each([
    '/',
    '/web',
    '/web/',
    '/web/assets/app.js',
    '/%77eb/index.html',
    '/strategy',
    '/group/list',
  ])('rejects unknown IP before serving HTML, assets, or API data: %s', async (path) => {
    const result = await request(app.getHttpServer())
      .get(path)
      .set('X-Real-IP', '203.0.113.99')
      .set('X-Forwarded-For', '203.0.113.4')
      .expect(403);
    expect(result.body.error.message).toBe('当前 IP 未获准访问运营后台');
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('rejects missing source and HEAD requests too', async () => {
    await request(app.getHttpServer()).get('/web/').expect(403);
    await request(app.getHttpServer())
      .head('/web/assets/app.js')
      .set('X-Real-IP', '203.0.113.99')
      .expect(403);
  });

  it('allows headquarters and retains the Henan route boundary', async () => {
    for (const ip of ['203.0.113.4', '1.193.23.48']) {
      for (const path of ['/web/', '/web/assets/app.js', '/group/list']) {
        await request(app.getHttpServer()).get(path).set('X-Real-IP', ip).expect(200);
      }
    }
    await request(app.getHttpServer()).get('/strategy').set('X-Real-IP', '203.0.113.4').expect(200);
    await request(app.getHttpServer()).get('/strategy').set('X-Real-IP', '1.193.23.48').expect(403);
  });

  it('keeps health and the exact callback methods reachable without exposing sibling APIs', async () => {
    await request(app.getHttpServer()).get('/agent/health').expect(200);
    await request(app.getHttpServer()).head('/agent/health').expect(200);
    for (const path of [
      '/message',
      '/message/sent-result',
      '/message/sentResult',
      '/new-customer',
    ]) {
      await request(app.getHttpServer()).post(path).send({}).expect(201);
      await request(app.getHttpServer()).get(path).expect(403);
    }
    for (const path of ['/message/send', '/message/unknown', '/agent/health']) {
      await request(app.getHttpServer()).post(path).send({}).expect(403);
    }
  });
});
