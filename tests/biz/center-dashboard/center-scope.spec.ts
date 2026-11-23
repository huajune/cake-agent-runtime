import { CenterScopeService } from '@biz/center-dashboard/center-scope.service';

import type { HostingBindingsRepository } from '@biz/center-dashboard/hosting-bindings.repository';

describe('Center scope from registered ownership', () => {
  const directory = { getAllGroups: jest.fn() };
  const accounts = { getConfiguredBotList: jest.fn() };
  const registered = { scope: jest.fn() };
  const bindings = registered as unknown as HostingBindingsRepository;
  let service: CenterScopeService;
  beforeEach(() => {
    jest.resetAllMocks();
    directory.getAllGroups.mockResolvedValue([
      { id: 'a', name: '杨晶组', description: '河南自招团队成员' },
      { id: 'b', name: '新小组', description: '补充说明\n河南自招团队成员\n备注' },
      { id: 'c', name: '河南自招团队成员', description: '不是河南自招团队成员' },
      { id: 'd', name: '总部', description: '' },
      { id: 'mixed', name: '待核对组', description: '河南自招团队成员\n上海自招团队成员' },
    ]);
    accounts.getConfiguredBotList.mockResolvedValue([
      { wxid: 'one', groupId: 'a' },
      { wxid: 'two', groupId: 'b' },
      { wxid: 'other', groupId: 'c' },
      { wxid: 'headquarters', groupId: 'd' },
      { wxid: 'mixed-owner', groupId: 'mixed' },
    ]);
    registered.scope.mockResolvedValue({
      groups: { a: 'henan', b: 'henan' },
      bots: { one: 'a', two: 'b' },
    });
    service = new CenterScopeService(directory, accounts, bindings);
  });
  it('intersects confirmed tenancies, current Stride accounts and registered membership', async () => {
    const scope = await service.getScope(false, 'henan');
    expect(scope.groups.map((group) => group.id)).toEqual(['a', 'b']);
    expect(scope.botIds).toEqual(['one', 'two']);
    expect(accounts.getConfiguredBotList).toHaveBeenCalledWith(true);
    await service.getScope(false, 'henan');
    expect(directory.getAllGroups).toHaveBeenCalledTimes(1);
  });
  it('ignores stale remarks when registered ownership differs', async () => {
    directory.getAllGroups.mockResolvedValue([
      { id: 'a', name: '旧备注', description: '河南自招团队成员' },
      { id: 'b', name: '新备注', description: '值班说明\r\n河南中心专用' },
    ]);
    registered.scope.mockResolvedValue({ groups: { b: 'new-supplier' }, bots: {} });
    expect((await service.getScope(false, 'new-supplier')).groups.map((group) => group.id)).toEqual(
      ['b'],
    );
  });
  it('keeps Shanghai recruitment isolated when both centers share a cached directory', async () => {
    directory.getAllGroups.mockResolvedValue([
      { id: 'a', name: '河南组', description: '河南自招团队成员' },
      { id: 'b', name: '上海组', description: '上海自招团队成员' },
      { id: 'c', name: '总部组', description: '上海智能体组内部成员' },
      { id: 'd', name: '待核对', description: '上海自招团队成员\n河南自招团队成员' },
    ]);
    registered.scope.mockResolvedValue({
      groups: { a: 'henan', b: 'shanghai_recruitment' },
      bots: { one: 'a', two: 'b' },
    });
    const [henan, shanghai] = await Promise.all([
      service.getScope(false, 'henan'),
      service.getScope(false, 'shanghai_recruitment'),
    ]);
    expect(henan.botIds).toEqual(['one']);
    expect(shanghai.botIds).toEqual(['two']);
    expect((await service.getScope(false, 'shanghai_recruitment')).groups.map((g) => g.id)).toEqual(
      ['b'],
    );
    expect(directory.getAllGroups).toHaveBeenCalledTimes(1);
  });
  it('refreshes ownership before a write; moved and pending bots lose access even while the live directory is cached', async () => {
    await service.getScope(false, 'henan');
    directory.getAllGroups.mockResolvedValue([
      { id: 'b', name: '新组', description: '河南自招团队成员' },
    ]);
    accounts.getConfiguredBotList.mockResolvedValue([
      { wxid: 'one', groupId: 'd' },
      { wxid: 'new-bot', groupId: 'b' },
    ]);
    registered.scope.mockResolvedValue({ groups: { b: 'henan' }, bots: { 'new-bot': 'b' } });
    expect((await service.getScope(true, 'henan')).botIds).toEqual(['new-bot']);
    registered.scope.mockResolvedValue({ groups: { b: 'henan' }, bots: {} });
    expect((await service.getScope(false, 'henan')).botIds).toEqual([]);
  });
  it('empty matches give an empty scope, while metadata failures never reuse stale permissions', async () => {
    directory.getAllGroups.mockResolvedValue([]);
    expect((await service.getScope(false, 'henan')).botIds).toEqual([]);
    directory.getAllGroups.mockRejectedValue(new Error('upstream down'));
    await expect(service.getScope(true, 'henan')).rejects.toThrow('无法确认');
    await expect(service.getScope(false, 'henan')).rejects.toThrow('无法确认');
  });
  it('does not let an older concurrent refresh overwrite a newer directory result', async () => {
    let release: (value: unknown[]) => void;
    directory.getAllGroups.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const old = service.getScope(false, 'henan');
    directory.getAllGroups.mockResolvedValue([]);
    await service.getScope(true, 'henan');
    release([{ id: 'a', name: 'old', description: '河南自招团队成员' }]);
    await old;
    expect((await service.getScope(false, 'henan')).groups).toEqual([]);
  });
});
