import { ActionLocalSyncService } from '@biz/action-execution/action-local-sync.service';
import type { ActionRecord } from '@biz/action-execution/action-execution.types';

describe('background local sync ownership', () => {
  const record = { intent: { chatId: 'chat-1' } } as ActionRecord;
  const lease = { key: 'wecom:message:lock:chat-1', owner: 'repair', ttlSeconds: 90 };
  const leases = { acquire: jest.fn(), renew: jest.fn(), release: jest.fn() };
  beforeEach(() => {
    jest.resetAllMocks();
    leases.acquire.mockResolvedValue(lease);
    leases.renew.mockResolvedValue(true);
  });

  it('waits for live conversation processing and never writes while busy', async () => {
    leases.acquire.mockResolvedValue(null);
    const sync = jest.fn();
    await expect(
      new ActionLocalSyncService(leases as never).run(record, { sync, reconcile: jest.fn() }),
    ).rejects.toThrow('busy');
    expect(leases.acquire).toHaveBeenCalledWith('wecom:message:lock:chat-1', 90);
    expect(sync).not.toHaveBeenCalled();
  });

  it('stops before the next projection write when a lease is lost during a read', async () => {
    const write = jest.fn();
    leases.renew.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(
      new ActionLocalSyncService(leases as never).run(record, {
        reconcile: jest.fn(),
        sync: async (_record, context) => {
          await context!.assertOwned();
          write();
        },
      }),
    ).rejects.toThrow('lease_lost');
    expect(write).not.toHaveBeenCalled();
    expect(leases.release).toHaveBeenCalledWith(lease);
  });

  it('does not mark an unbounded repair successful after its write budget expires', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await expect(
        new ActionLocalSyncService(leases as never).run(record, {
          reconcile: jest.fn(),
          sync: async () => {
            now.mockReturnValue(32000);
          },
        }),
      ).rejects.toThrow('lease_lost');
      expect(leases.release).toHaveBeenCalledWith(lease);
    } finally {
      now.mockRestore();
    }
  });
});
