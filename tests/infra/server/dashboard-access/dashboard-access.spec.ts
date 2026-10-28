import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { DashboardAccessGuard } from '@infra/server/dashboard-access/dashboard-access.guard';

const request = (peer: string, headers = {}, path = '/dashboard/access', method = 'GET') =>
  ({ socket: { remoteAddress: peer }, headers, path, method }) as Request;
const context = (req: Request) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as ExecutionContext;
const config = {
  HENAN_DASHBOARD_IPS: '1.193.23.48',
  HENAN_DASHBOARD_BOT_IDS: 'center-bot',
  DASHBOARD_TRUSTED_PROXY_IPS: '172.18.0.1',
};

describe('Dashboard source scope', () => {
  const access = new DashboardAccessService(new ConfigService(config));
  const guard = new DashboardAccessGuard(access);
  const centerRequest = (path: string, method = 'GET') =>
    request('172.18.0.1', { 'x-real-ip': '1.193.23.48' }, path, method);

  it('uses only the overwritten header from an explicitly trusted proxy', () => {
    expect(access.resolve(centerRequest('/')).centerId).toBe('henan');
    expect(access.resolve(request('1.193.23.48', { 'x-real-ip': '8.8.8.8' })).centerId).toBe(
      'henan',
    );
    expect(
      access.resolve(
        request('172.18.0.1', { 'x-real-ip': '1.193.23.48', 'x-forwarded-for': '8.8.8.8' }),
      ).centerId,
    ).toBe('henan');
    expect(access.resolve(request('::ffff:1.193.23.48')).centerId).toBe('henan');
  });

  it.each([{}, { 'x-real-ip': 'bad' }, { 'x-real-ip': ['1.193.23.48', '8.8.8.8'] }])(
    'denies invalid trusted-proxy headers',
    (headers) => {
      expect(() => guard.canActivate(context(request('172.18.0.1', headers)))).toThrow();
    },
  );

  it.each([
    '/group/list',
    '/bot/configured-list',
    '/config/blacklist',
    '/analytics/users',
    '/analytics/chat-sessions-optimized',
    '/analytics/chat-sessions/chat/messages',
    '/analytics/message-processing-records/id',
    '/analytics/reengagement-candidates',
    '/analytics/reengagement-records/detail',
    '/dashboard/access',
    '/dashboard/events',
    '/web/hosting',
  ])('allows original scoped read endpoint: %s', (path) => {
    expect(guard.canActivate(context(centerRequest(path)))).toBe(true);
  });
  it.each([
    '/strategy',
    '/feishu/send',
    '/config/agent-config',
    '/config/ai-reply-status',
    '/config/toggle-ai-reply',
    '/analytics/dashboard/overview',
    '/user/users/paused',
    '/center-dashboard/users',
  ])('blocks unauthorized endpoint: %s', (path) => {
    expect(() => guard.canActivate(context(centerRequest(path)))).toThrow();
  });
  it('denies writes even to an allowed read path', () => {
    expect(() =>
      guard.canActivate(context(centerRequest('/center-dashboard/users', 'POST'))),
    ).toThrow();
  });
  it('allows only same-origin JSON group switch writes, never legacy global/group controls', () => {
    const req = centerRequest('/config/blacklist', 'POST');
    Object.assign(req.headers, {
      host: 'cake.example.com',
      origin: 'https://cake.example.com',
      'x-center-action': 'hosting',
      'content-type': 'application/json',
    });
    expect(guard.canActivate(context(req))).toBe(true);
    for (const path of [
      '/config/agent-config',
      '/config/toggle-ai-reply',
      '/center-dashboard/hosting/foreign',
    ]) {
      expect(() => guard.canActivate(context({ ...req, path } as Request))).toThrow();
    }
    req.headers.origin = 'https://foreign.example.com';
    expect(() => guard.canActivate(context(req))).toThrow();
    delete req.headers.origin;
    expect(() => guard.canActivate(context(req))).toThrow();
    req.headers.origin = 'https://cake.example.com';
    delete req.headers['x-center-action'];
    expect(() => guard.canActivate(context(req))).toThrow();
  });
  it('preserves existing behavior for other network sources and disabled configuration', () => {
    expect(
      guard.canActivate(
        context(request('172.18.0.1', { 'x-real-ip': '203.0.113.4' }, '/config', 'POST')),
      ),
    ).toBe(true);
    expect(
      new DashboardAccessService(new ConfigService()).resolve(request('1.193.23.48')).centerId,
    ).toBeNull();
  });
  it('refuses partial activation and invalid address configuration', () => {
    expect(
      () => new DashboardAccessService(new ConfigService({ HENAN_DASHBOARD_IPS: '1.193.23.48' })),
    ).toThrow();
    expect(
      () =>
        new DashboardAccessService(
          new ConfigService({ ...config, DASHBOARD_TRUSTED_PROXY_IPS: '*' }),
        ),
    ).toThrow();
  });
});
