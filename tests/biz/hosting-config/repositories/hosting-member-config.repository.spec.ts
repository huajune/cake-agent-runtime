import { HostingMemberConfigRepository } from '@biz/hosting-config/repositories/hosting-member-config.repository';
import { HOSTING_MEMBER_CONFIG_KEY } from '@biz/hosting-config/types/hosting-member-config.types';

describe('HostingMemberConfigRepository', () => {
  function buildRepository(initialized = true) {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(),
    };
    const from = jest.fn().mockReturnValue(query);
    const repository = new HostingMemberConfigRepository({
      getSupabaseClient: () => ({ from }),
      isClientInitialized: () => initialized,
    } as never);
    return { repository, query, from };
  }

  it('reads the single DB record and preserves receiver and persona fields', async () => {
    const { repository, query, from } = buildRepository();
    const value = {
      members: { 'henan-bot': { feishuOpenId: 'ou_henan', dulidayToken: 'private', gender: '男' } },
      operationsReceivers: [{ openId: ' ou_ops ', name: '运营' }],
      taskOwners: { default: [' ou_default '] },
    };
    query.maybeSingle.mockResolvedValue({ data: { value }, error: null });
    await expect(repository.readConfig()).resolves.toEqual({
      ...value,
      operationsReceivers: [{ openId: 'ou_ops', name: '运营' }],
      taskOwners: { default: ['ou_default'] },
    });
    expect(from).toHaveBeenCalledWith('system_config');
    expect(query.eq).toHaveBeenCalledWith('key', HOSTING_MEMBER_CONFIG_KEY);
  });

  it('distinguishes intentional deletion from DB failure', async () => {
    const { repository, query } = buildRepository();
    query.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(repository.readConfig()).resolves.toBeNull();
    query.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'private' },
    });
    await expect(repository.readConfig()).rejects.toThrow('读取托管成员配置失败');
    await expect(buildRepository(false).repository.readConfig()).rejects.toThrow('暂不可用');
  });

  it.each([
    [],
    { members: [] },
    { members: { bot: { feishuOpenId: 42 } } },
    { operationsReceivers: [{ openId: ' ', name: 'invalid' }] },
    { taskOwners: { T4: 'not-an-array' } },
  ])('rejects malformed config so the service can retain its last good snapshot', async (value) => {
    const { repository, query } = buildRepository();
    query.maybeSingle.mockResolvedValue({ data: { value }, error: null });
    await expect(repository.readConfig()).rejects.toThrow('配置格式无效');
  });
});
