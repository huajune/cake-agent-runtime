import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { DashboardAccessService } from '@infra/server/dashboard-access/dashboard-access.service';
import { ApiTokenGuard, IS_PUBLIC_KEY } from '@infra/server/guards/api-token.guard';
import { MessageOpsController } from '@wecom/message/ingress/message-ops.controller';

describe('API authentication', () => {
  const authenticate = jest.fn();
  const flags = { getAllAndOverride: jest.fn() };
  function guard(token?: string) {
    return new ApiTokenGuard(
      new ConfigService({ CAKE_MACHINE_API_TOKEN: token }),
      flags as unknown as Reflector,
      { authenticate } as unknown as DashboardAccessService,
    );
  }
  function ctx(authorization?: string): ExecutionContext {
    return {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization },
          path: '/dashboard/accounts',
          method: 'GET',
        }),
      }),
    } as unknown as ExecutionContext;
  }
  beforeEach(() => {
    jest.resetAllMocks();
  });
  it('preserves public callbacks and the health check', async () => {
    flags.getAllAndOverride.mockImplementation((key) => key === IS_PUBLIC_KEY);
    await expect(guard().canActivate(ctx())).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('requires authentication even when no machine secret is configured', async () => {
    await expect(guard().canActivate(ctx())).rejects.toMatchObject({ status: 401 });
    authenticate.mockRejectedValue(new UnauthorizedException());
    await expect(guard().canActivate(ctx('Bearer retired-shared-token'))).rejects.toMatchObject({
      status: 401,
    });
  });
  it('accepts the new machine credential only on explicitly enabled handlers', async () => {
    await expect(guard('machine').canActivate(ctx('Bearer machine'))).rejects.toMatchObject({
      status: 403,
    });
    flags.getAllAndOverride.mockImplementation((key) => key === 'allowMachineAccess');
    await expect(guard('machine').canActivate(ctx('Bearer machine'))).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('allows the rollout worker status and concurrency calls with the machine credential', async () => {
    const access = new ApiTokenGuard(
      new ConfigService({ CAKE_MACHINE_API_TOKEN: 'worker-machine' }),
      new Reflector(),
      { authenticate } as unknown as DashboardAccessService,
    );
    const workerContext = (handler: keyof MessageOpsController) =>
      ({
        ...ctx('Bearer worker-machine'),
        getHandler: () => MessageOpsController.prototype[handler],
        getClass: () => MessageOpsController,
      }) as ExecutionContext;
    await expect(access.canActivate(workerContext('getWorkerStatus'))).resolves.toBe(true);
    await expect(access.canActivate(workerContext('setWorkerConcurrency'))).resolves.toBe(true);
    await expect(access.canActivate(workerContext('getQueueStatus'))).rejects.toMatchObject({
      status: 403,
    });
  });
  it('gates headquarters routes by organization', async () => {
    authenticate.mockResolvedValue({ organization: 'henan' });
    await expect(guard().canActivate(ctx('Bearer personal'))).rejects.toMatchObject({
      status: 403,
    });
    authenticate.mockResolvedValue({
      organization: 'headquarters',
      tenant: { name: '总部', readsAllTenants: true },
    });
    await expect(guard().canActivate(ctx('Bearer personal'))).resolves.toBe(true);
  });
  it('requires the bound administrator on admin-only handlers even when another access flag is set', async () => {
    flags.getAllAndOverride.mockReturnValue(true);
    await expect(guard('machine').canActivate(ctx('Bearer machine'))).rejects.toMatchObject({
      status: 403,
    });
    authenticate.mockResolvedValue({
      organization: 'headquarters',
      tenant: { name: '总部', readsAllTenants: true },
      name: 'cakeadmin',
    });
    await expect(guard().canActivate(ctx('Bearer staff'))).rejects.toMatchObject({ status: 403 });
    authenticate.mockResolvedValue({
      organization: 'headquarters',
      tenant: { name: '总部', readsAllTenants: true },
      loginName: 'cakeadmin',
    });
    await expect(guard().canActivate(ctx('Bearer administrator'))).resolves.toBe(true);
  });
});
