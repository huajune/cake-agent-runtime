import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import request = require('supertest');
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { DashboardAccessGuard } from '@infra/server/dashboard-access/dashboard-access.guard';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { HttpExceptionFilter } from '@infra/server/response/filters/http-exception.filter';
import { dashboardWebMiddleware } from '@infra/server/web-entry/dashboard-web.middleware';

const handlers = jest.fn();
@Controller()
class DashboardHttpFixture {
  @Get('dashboard/access') access() {
    handlers();
    return { allowed: true };
  }
  @Get('config/agent-config') config() {
    handlers();
    return { private: true };
  }
  @Post('config/agent-config') write() {
    handlers();
    return { saved: true };
  }
  @Public()
  @Get('strategy')
  strategy() {
    handlers();
    return { private: true };
  }
  @Public()
  @Post('message')
  message() {
    handlers();
    return { accepted: true };
  }
  @Public()
  @Post('message/sent-result')
  result() {
    handlers();
    return { accepted: true };
  }
  @Public()
  @Post('message/sentResult')
  camelResult() {
    handlers();
    return { accepted: true };
  }
  @Public()
  @Post('new-customer')
  customer() {
    handlers();
    return { accepted: true };
  }
  @Public()
  @Get('agent/health')
  health() {
    handlers();
    return { healthy: true };
  }
  @Public()
  @Get('web/*')
  web() {
    handlers();
    return 'SPA route';
  }
}

describe('Dashboard IP gate before static files and controller handlers', () => {
  let app: NestExpressApplication;
  let publicPath: string;
  beforeAll(async () => {
    publicPath = await mkdtemp(join(tmpdir(), 'cake-ip-gate-'));
    await mkdir(join(publicPath, 'web', 'assets'), { recursive: true });
    await writeFile(join(publicPath, 'web', 'index.html'), 'private SPA entry');
    await writeFile(join(publicPath, 'web', 'assets', 'app.js'), 'private SPA bundle');
    await copyFile(
      join(process.cwd(), 'public', 'access-denied.html'),
      join(publicPath, 'access-denied.html'),
    );
    const config = new ConfigService({
      API_GUARD_TOKEN: 'http-test-token',
      HEADQUARTERS_DASHBOARD_IPS: '203.0.113.10',
      HENAN_DASHBOARD_IPS: '198.51.100.20',
      DASHBOARD_TRUSTED_PROXY_IPS: '127.0.0.1,::1',
    });
    const module = await Test.createTestingModule({
      controllers: [DashboardHttpFixture],
      providers: [
        DashboardAccessService,
        DashboardAccessGuard,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    // 顺序与 main.ts 一致：检查必须先于 express.static，单靠 Nest Guard 无法保护静态文件。
    app.use(dashboardWebMiddleware(app.get(DashboardAccessService), publicPath));
    app.useStaticAssets(publicPath);
    app.useGlobalGuards(app.get(DashboardAccessGuard), new ApiTokenGuard(config, new Reflector()));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await rm(publicPath, { recursive: true, force: true });
  });
  beforeEach(() => handlers.mockClear());

  it.each([
    '/',
    '/web',
    '/web/',
    '/web/hosting',
    '/web/config?tab=models',
    '/web/index.html',
    '/web/assets/app.js',
    '/web%2Findex.html',
    '/%77eb/index.html',
    '//web/index.html',
    '/WEB/hosting',
  ])('redirects an unknown IP before serving %s', async (path) => {
    const result = await request(app.getHttpServer())
      .get(path)
      .set('X-Real-IP', '192.0.2.99')
      .expect(303);
    expect(result.headers.location).toBe('/web/access-denied');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.text).not.toContain('private SPA');
    expect(handlers).not.toHaveBeenCalled();
  });
  it('does not redirect the permission page again and serves it without scripts or APIs', async () => {
    const result = await request(app.getHttpServer()).get('/web/access-denied').expect(200);
    expect(result.text).toContain('无访问权限');
    expect(result.text).toContain('href="/web/"');
    expect(result.text).not.toContain('<script');
    expect(result.headers.location).toBeUndefined();
    expect(result.headers['cache-control']).toBe('no-store');
    expect(handlers).not.toHaveBeenCalled();
  });
  it('also gates HEAD and conditional requests before returning cached static content', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/web/index.html')
      .set('X-Real-IP', '203.0.113.10')
      .expect(200);
    await request(app.getHttpServer())
      .get('/web/index.html')
      .set('X-Real-IP', '192.0.2.99')
      .set('If-None-Match', allowed.headers.etag)
      .expect(303);
    const head = await request(app.getHttpServer()).head('/web/hosting').expect(303);
    expect(head.headers.location).toBe('/web/access-denied');
    await request(app.getHttpServer()).head('/web/access-denied').expect(200);
  });
  it.each(['203.0.113.10', '198.51.100.20'])(
    'allows trusted HQ/center IP %s to load the web entry',
    async (ip) => {
      const result = await request(app.getHttpServer())
        .get('/web/index.html')
        .set('X-Real-IP', ip)
        .expect(200);
      expect(result.text).toBe('private SPA entry');
      expect(result.headers['cache-control']).toBe('no-store');
      await request(app.getHttpServer()).get('/web/hosting').set('X-Real-IP', ip).expect(200);
    },
  );
  it.each(['get', 'post'] as const)(
    'rejects %s data requests even with a correct API token',
    async (method) => {
      const result = await request(app.getHttpServer())
        [method]('/config/agent-config')
        .set('X-Real-IP', '192.0.2.99')
        .set('Authorization', 'Bearer http-test-token')
        .expect(403);
      expect(result.body.error.code).toBe('DASHBOARD_IP_DENIED');
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers.location).toBeUndefined();
      expect(handlers).not.toHaveBeenCalled();
    },
  );
  it('blocks access lookup and public-marked business APIs for unknown IPs', async () => {
    for (const path of ['/dashboard/access', '/strategy']) {
      const result = await request(app.getHttpServer())
        .get(path)
        .set('X-Real-IP', '192.0.2.99')
        .expect(403);
      expect(result.body.error.code).toBe('DASHBOARD_IP_DENIED');
    }
    expect(handlers).not.toHaveBeenCalled();
  });
  it('retains API token authentication and center feature restrictions', async () => {
    await request(app.getHttpServer())
      .get('/config/agent-config')
      .set('X-Real-IP', '203.0.113.10')
      .expect(403);
    const deniedFeature = await request(app.getHttpServer())
      .get('/config/agent-config')
      .set('X-Real-IP', '198.51.100.20')
      .set('Authorization', 'Bearer http-test-token')
      .expect(403);
    expect(deniedFeature.body.error.code).toBe('FORBIDDEN');
    await request(app.getHttpServer())
      .get('/config/agent-config')
      .set('X-Real-IP', '203.0.113.10')
      .set('Authorization', 'Bearer http-test-token')
      .expect(200);
    expect(handlers).toHaveBeenCalledTimes(1);
  });
  it.each(['/message', '/message/sent-result', '/message/sentResult', '/new-customer'])(
    'keeps third-party POST %s available without broad path exemptions',
    async (path) => {
      await request(app.getHttpServer())
        .post(path)
        .set('X-Real-IP', '192.0.2.99')
        .send({})
        .expect(201);
      expect(handlers).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps the health probe available and denies a proxy with missing or malformed source', async () => {
    await request(app.getHttpServer()).get('/agent/health').expect(200);
    for (const ip of ['', 'invalid', '203.0.113.10,192.0.2.99']) {
      await request(app.getHttpServer())
        .get('/web/hosting')
        .set('X-Real-IP', ip)
        .set('X-Forwarded-For', '203.0.113.10')
        .expect(303);
    }
  });
});
