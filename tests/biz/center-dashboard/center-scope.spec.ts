import { ConfigService } from '@nestjs/config';
import { CenterScopeService } from '@biz/center-dashboard/center-scope.service';

describe('Center scope from group description', () => {
  const directory = { getAllGroups: jest.fn() };
  const accounts = { getConfiguredBotList: jest.fn() };
  let service: CenterScopeService;
  beforeEach(() => {
    jest.resetAllMocks();
    directory.getAllGroups.mockResolvedValue([
      { id: 'a', name: '杨晶组', description: '河南自招团队成员' },
      { id: 'b', name: '新小组', description: '补充说明\n河南自招团队成员\n备注' },
      { id: 'c', name: '河南自招团队成员', description: '不是河南自招团队成员' },
      { id: 'd', name: '总部', description: '' },
    ]);
    accounts.getConfiguredBotList.mockResolvedValue([
      { wxid: 'one', groupId: 'a' },
      { wxid: 'two', groupId: 'b' },
      { wxid: 'other', groupId: 'c' },
      { wxid: 'headquarters', groupId: 'd' },
    ]);
    service = new CenterScopeService(directory, accounts, new ConfigService());
  });
  it('uses the exact description line across multiple groups, never group names or negated text', async () => {
    const scope = await service.getScope();
    expect(scope.groups.map((group) => group.id)).toEqual(['a', 'b']);
    expect(scope.botIds).toEqual(['one', 'two']);
    expect(accounts.getConfiguredBotList).toHaveBeenCalledWith(true);
    await service.getScope();
    expect(directory.getAllGroups).toHaveBeenCalledTimes(1);
  });
  it('refreshes ownership before a write; removed descriptions and moved bots lose access', async () => {
    await service.getScope();
    directory.getAllGroups.mockResolvedValue([
      { id: 'b', name: '新组', description: '河南自招团队成员' },
    ]);
    accounts.getConfiguredBotList.mockResolvedValue([
      { wxid: 'one', groupId: 'd' },
      { wxid: 'new-bot', groupId: 'b' },
    ]);
    expect((await service.getScope(true)).botIds).toEqual(['new-bot']);
  });
  it('empty matches give an empty scope, while metadata failures never reuse stale permissions', async () => {
    directory.getAllGroups.mockResolvedValue([]);
    expect((await service.getScope()).botIds).toEqual([]);
    directory.getAllGroups.mockRejectedValue(new Error('upstream down'));
    await expect(service.getScope(true)).rejects.toThrow('无法确认');
    await expect(service.getScope()).rejects.toThrow('无法确认');
  });
  it('does not let an older concurrent refresh overwrite a newer directory result', async () => {
    let release: (value: unknown[]) => void;
    directory.getAllGroups.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const old = service.getScope();
    directory.getAllGroups.mockResolvedValue([]);
    await service.getScope(true);
    release([{ id: 'a', name: 'old', description: '河南自招团队成员' }]);
    await old;
    expect((await service.getScope()).groups).toEqual([]);
  });
});
