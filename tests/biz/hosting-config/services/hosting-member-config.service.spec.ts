import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';

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

  it('falls back to the hard-coded Feishu receiver when DB has no openId', async () => {
    repository.readConfig.mockResolvedValueOnce({ members: {} });
    const service = new HostingMemberConfigService(repository as never);

    await expect(service.resolveFeishuReceiver('1688855171908166')).resolves.toEqual(
      BOT_TO_RECEIVER['1688855171908166'],
    );
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
    await expect(service.resolveFeishuReceiver('1688855974513959')).resolves.toEqual(
      BOT_TO_RECEIVER['1688855974513959'],
    );
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
