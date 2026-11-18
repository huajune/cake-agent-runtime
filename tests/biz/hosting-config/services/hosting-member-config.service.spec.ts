import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';

describe('HostingMemberConfigService', () => {
  const repository = {
    readConfig: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repository.readConfig.mockResolvedValue({
      members: {
        '1688855974513959': {
          feishuOpenId: ' ou_custom ',
          feishuName: ' 琪琪 ',
          dulidayToken: ' token-custom ',
        },
      },
    });
  });

  it('resolves member config by normalized botImId', async () => {
    const service = new HostingMemberConfigService(repository as never);

    await expect(service.getByBotImId('prod-sync:1688855974513959')).resolves.toEqual({
      feishuOpenId: ' ou_custom ',
      feishuName: ' 琪琪 ',
      dulidayToken: ' token-custom ',
    });
    expect(repository.readConfig).toHaveBeenCalledTimes(1);
  });

  it('prefers DB receiver/token and trims returned values', async () => {
    const service = new HostingMemberConfigService(repository as never);

    await expect(service.resolveFeishuReceiver('1688855974513959')).resolves.toEqual({
      openId: 'ou_custom',
      name: '琪琪',
    });
    await expect(service.resolveDulidayToken('1688855974513959')).resolves.toBe('token-custom');
  });

  it('does not resurrect a former code receiver when DB has no openId', async () => {
    repository.readConfig.mockResolvedValueOnce({ members: {} });
    const service = new HostingMemberConfigService(repository as never);

    await expect(service.resolveFeishuReceiver('1688855171908166')).resolves.toBeUndefined();
    await expect(service.resolveDulidayToken('1688855171908166')).resolves.toBeNull();
  });

  it('caches the loaded config across repeated lookups', async () => {
    const service = new HostingMemberConfigService(repository as never);

    await service.resolveDulidayToken('1688855974513959');
    await service.resolveFeishuReceiver('1688855974513959');

    expect(repository.readConfig).toHaveBeenCalledTimes(1);
  });

  it('falls back when repository read fails', async () => {
    repository.readConfig.mockRejectedValueOnce(new Error('db down'));
    const service = new HostingMemberConfigService(repository as never);

    await expect(service.resolveDulidayToken('1688855974513959')).resolves.toBeNull();
    await expect(service.resolveFeishuReceiver('1688855974513959')).resolves.toBeUndefined();
  });

  describe('database refresh', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('refreshes account, operations and task receivers after five minutes', async () => {
      repository.readConfig.mockResolvedValueOnce({
        members: { henan: { feishuOpenId: 'ou_henan', feishuName: '河南成员' } },
        operationsReceivers: [{ openId: 'ou_ops', name: '原运营' }],
        taskOwners: { supervisor: ['ou_supervisor'] },
      });
      const service = new HostingMemberConfigService(repository as never);
      await expect(service.resolveFeishuReceiver('prod-sync:henan')).resolves.toEqual({
        openId: 'ou_henan',
        name: '河南成员',
      });
      await expect(service.resolveOperationsReceivers()).resolves.toEqual([
        { openId: 'ou_ops', name: '原运营' },
      ]);
      await expect(service.resolveTaskOwners()).resolves.toEqual({ supervisor: ['ou_supervisor'] });
      repository.readConfig.mockResolvedValue({
        members: {},
        operationsReceivers: [],
        taskOwners: {},
      });
      jest.advanceTimersByTime(299999);
      expect(await service.resolveFeishuReceiver('henan')).toBeDefined();
      jest.advanceTimersByTime(1);
      await expect(service.resolveFeishuReceiver('henan')).resolves.toBeUndefined();
      await expect(service.resolveOperationsReceivers()).resolves.toEqual([]);
      await expect(service.resolveTaskOwners()).resolves.toEqual({});
      expect(repository.readConfig).toHaveBeenCalledTimes(2);
    });

    it('retains last successful DB configuration during failure and recovers on the next refresh', async () => {
      const service = new HostingMemberConfigService(repository as never);
      await service.resolveFeishuReceiver('1688855974513959');
      repository.readConfig.mockRejectedValueOnce(new Error('database unavailable'));
      jest.advanceTimersByTime(300000);
      await expect(service.resolveFeishuReceiver('1688855974513959')).resolves.toEqual({
        openId: 'ou_custom',
        name: '琪琪',
      });
      await expect(service.resolveDulidayToken('1688855974513959')).resolves.toBe('token-custom');
      repository.readConfig.mockResolvedValueOnce(null);
      jest.advanceTimersByTime(300000);
      await expect(service.resolveFeishuReceiver('1688855974513959')).resolves.toBeUndefined();
    });

    it('coalesces concurrent refreshes and deduplicates operations identities', async () => {
      repository.readConfig.mockResolvedValue({
        operationsReceivers: [
          { openId: ' ou_ops ', name: ' 运营 ' },
          { openId: 'ou_ops', name: '运营' },
        ],
      });
      const service = new HostingMemberConfigService(repository as never);
      const [receivers] = await Promise.all([
        service.resolveOperationsReceivers(),
        service.resolveTaskOwners(),
        service.getByBotImId('bot'),
      ]);
      expect(receivers).toEqual([{ openId: 'ou_ops', name: '运营' }]);
      expect(repository.readConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveAgentAccountIdentity (badcase chat 6a5dedb2ce406a6aeee1ea62)', () => {
    it('resolves configured nickname and gender with trimming', async () => {
      repository.readConfig.mockResolvedValue({
        members: {
          '1688854363869800': { wecomNickname: ' 祝东升 ', gender: ' 男 ' },
        },
      });
      const service = new HostingMemberConfigService(repository as never);

      await expect(service.resolveAgentAccountIdentity('1688854363869800')).resolves.toEqual({
        nickname: '祝东升',
        gender: '男',
      });
    });

    it('resolves by normalized botImId (sync prefix stripped)', async () => {
      repository.readConfig.mockResolvedValue({
        members: { '1688854363869800': { wecomNickname: '祝东升', gender: '男' } },
      });
      const service = new HostingMemberConfigService(repository as never);

      await expect(
        service.resolveAgentAccountIdentity('prod-sync:1688854363869800'),
      ).resolves.toEqual({ nickname: '祝东升', gender: '男' });
    });

    it('returns null fields when not configured or config read fails', async () => {
      repository.readConfig.mockResolvedValue({ members: {} });
      const service = new HostingMemberConfigService(repository as never);
      await expect(service.resolveAgentAccountIdentity('1688854363869800')).resolves.toEqual({
        nickname: null,
        gender: null,
      });

      repository.readConfig.mockRejectedValueOnce(new Error('db down'));
      const failing = new HostingMemberConfigService(repository as never);
      await expect(failing.resolveAgentAccountIdentity('1688854363869800')).resolves.toEqual({
        nickname: null,
        gender: null,
      });
    });
  });
});
