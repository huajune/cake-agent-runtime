import { ReplyRecoveryLeaseService } from '@biz/reply-execution/reply-recovery-lease.service';

describe('ReplyRecoveryLeaseService', () => {
  const leases = { acquire: jest.fn(), renew: jest.fn(), release: jest.fn() };
  const service = new ReplyRecoveryLeaseService(leases as never);
  beforeEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
    leases.acquire.mockResolvedValue({ key: 'chat', owner: 'owner' });
    leases.renew.mockResolvedValue(true);
    leases.release.mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());
  it('does not run if the live conversation owns the lease', async () => {
    leases.acquire.mockResolvedValue(null);
    const task = jest.fn();
    await service.run('chat', task);
    expect(task).not.toHaveBeenCalled();
  });
  it('stops subsequent writes when ownership is lost', async () => {
    const write = jest.fn();
    await expect(
      service.run('chat', async (owned) => {
        await owned();
        write();
        leases.renew.mockResolvedValue(false);
        await owned();
        write();
      }),
    ).rejects.toThrow('lease_or_budget_lost');
    expect(write).toHaveBeenCalledTimes(1);
    expect(leases.release).toHaveBeenCalledTimes(1);
  });
  it('checks the operation budget without abandoning an in-flight write', async () => {
    jest.useFakeTimers();
    const write = jest.fn();
    await expect(
      service.run('chat', async (owned) => {
        jest.advanceTimersByTime(30_001);
        await owned();
        write();
      }),
    ).rejects.toThrow('lease_or_budget_lost');
    expect(write).not.toHaveBeenCalled();
    expect(leases.release).toHaveBeenCalledTimes(1);
  });
});
