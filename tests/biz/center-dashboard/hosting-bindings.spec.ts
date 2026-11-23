import { ConfigService } from '@nestjs/config';
import { HostingBindingsService } from '@biz/center-dashboard/hosting-bindings.service';
import type { HostingBindingsRepository } from '@biz/center-dashboard/hosting-bindings.repository';
import type { CenterScopeService } from '@biz/center-dashboard/center-scope.service';
import type { CronRunnerService } from '@infra/queue/cron-runner.service';

describe('Daily Stride directory synchronization', () => {
  const directory = { getAllGroups: jest.fn() };
  const accounts = { getConfiguredBotList: jest.fn() };
  const db = { call: jest.fn() };
  const scope = { invalidate: jest.fn() };
  const cron = { run: jest.fn() };
  const make = (settings: Record<string, string> = {}) =>
    new HostingBindingsService(
      db as unknown as HostingBindingsRepository,
      directory,
      accounts,
      scope as unknown as CenterScopeService,
      cron as unknown as CronRunnerService,
      { get: (key: string) => settings[key] } as ConfigService,
    );
  beforeEach(() => {
    jest.resetAllMocks();
    directory.getAllGroups.mockResolvedValue([
      { id: 'a', name: '杨晶组' },
      { id: 'b', name: '空组' },
    ]);
    accounts.getConfiguredBotList.mockResolvedValue([
      { wxid: 'wx-a', groupId: 'a', name: '值班号' },
    ]);
  });
  it('coalesces overlapping manual and scheduled reads and submits a complete snapshot', async () => {
    const service = make();
    await Promise.all([service.sync(), service.sync()]);
    expect(directory.getAllGroups).toHaveBeenCalledTimes(1);
    expect(accounts.getConfiguredBotList).toHaveBeenCalledWith(true, expect.any(AbortSignal));
    expect(db.call).toHaveBeenCalledWith('sync_hosting_directory', {
      p_started_at: expect.any(String),
      p_groups: [
        { id: 'a', name: '杨晶组' },
        { id: 'b', name: '空组' },
      ],
      p_bots: [{ id: 'wx-a', group_id: 'a', name: '值班号' }],
    });
  });
  it('a partial read leaves the last snapshot and ownership untouched; the next sync can recover', async () => {
    const service = make();
    accounts.getConfiguredBotList.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.sync()).rejects.toThrow('读取失败');
    expect(db.call).not.toHaveBeenCalled();
    await expect(service.sync()).resolves.toBe(3);
  });
  it('acquires the managed cron lease before reconciling and polling', async () => {
    const limits = { checkpoint: jest.fn(), recordProcessed: jest.fn() };
    cron.run.mockImplementation((_id, _limits, fn) => fn(limits));
    db.call.mockResolvedValue(0);
    await make({ NODE_ENV: 'production' }).scheduledSync();
    expect(cron.run).toHaveBeenCalledTimes(1);
    expect(db.call.mock.calls.map((c) => c[0])).toEqual([
      'reconcile_hosting_handover',
      'reconcile_business_handover',
      'sync_hosting_directory',
    ]);
    await make({ NODE_ENV: 'development' }).scheduledSync();
    expect(cron.run).toHaveBeenCalledTimes(1);
  });
  it('acknowledges a committed transfer when the first repair batch needs a retry', async () => {
    db.call
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('batch timed out'));
    await expect(
      make().confirm('handover', 'new-group', '2026-11-20T00:00:00Z', 'admin'),
    ).resolves.toBeUndefined();
    expect(db.call.mock.calls.map((c) => c[0])).toEqual([
      'sync_hosting_directory',
      'confirm_hosting_handover',
      'reconcile_hosting_handover',
    ]);
  });
});
