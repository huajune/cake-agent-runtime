import { DEFAULT_HENAN_GROUP_MARKER } from '@/types/hosting-group';
import { summarizeHostingGroups } from '../../web/src/view/hosting/list/group-sections';

describe('小组托管状态分组', () => {
  it('按整行标识汇总可见小组，保留补充备注及小组 ID', () => {
    const result = summarizeHostingGroups(
      [
        { id: 'pending', name: '河南自招团队成员', description: '非河南自招团队成员' },
        { id: 'ai', name: '一组', description: '上海智能体组内部成员' },
        { id: 'sh', name: '一组', description: '上海自招团队成员' },
        { id: 'a', name: '一组', description: '晚班\r\n 河南自招团队成员 \n河南自招团队成员' },
        { id: 'b', name: '二组', description: DEFAULT_HENAN_GROUP_MARKER },
        { id: 'blank', name: '三组' },
        { id: 'conflict', name: '四组', description: '河南自招团队成员\n上海自招团队成员' },
      ],
      ['a', 'a', 'outside', 'sh'],
      DEFAULT_HENAN_GROUP_MARKER,
    );
    expect(result.total).toBe(7);
    expect(result.blockedCount).toBe(2);
    expect(
      result.sections.map((section) => [section.name, section.groups.length, section.blocked]),
    ).toEqual([
      ['上海智能体组', 1, 0],
      ['上海自招团队', 1, 1],
      ['河南自招中心', 2, 1],
      ['归属待确认', 3, 0],
    ]);
    expect(result.sections[2].groups).toEqual([
      { id: 'a', name: '一组', note: '晚班', blocked: true, canToggle: false },
      { id: 'b', name: '二组', note: '', blocked: false, canToggle: false },
    ]);
    expect(result.sections[3].groups[2].note).toBe('河南自招团队成员\n上海自招团队成员');
  });

  it('使用服务端配置的河南标识，中心视图遵循已授权的组织', () => {
    const group = { id: 'bot-group', name: '新小组', description: '单独备注\n河南专用标识' };
    const hq = summarizeHostingGroups([group], [], '河南专用标识');
    expect(hq.sections[0].name).toBe('河南自招中心');
    expect(hq.sections[0].groups[0].note).toBe('单独备注');
    const old = { ...group, description: DEFAULT_HENAN_GROUP_MARKER };
    expect(summarizeHostingGroups([old], [], '河南专用标识').sections[0].name).toBe('归属待确认');
    const center = summarizeHostingGroups([group], ['outside'], '河南专用标识', {
      organization: 'henan',
      isAdministrator: false,
    });
    expect(center).toEqual(hq);
  });
  it('总部能查看全部小组，个人账号只操作登记在自己组织的小组', () => {
    const groups = [
      { id: 'a', name: '智能体组', tenantId: 'headquarters' },
      { id: 'b', name: '中心组', tenantId: 'henan' },
      { id: 'c', name: '待绑定', tenantId: null },
      { id: 'd', name: '仅有备注', description: '上海智能体组内部成员' },
    ];
    const permissions = (organization: 'headquarters' | 'henan', isAdministrator = false) =>
      Object.fromEntries(
        summarizeHostingGroups(groups, [], DEFAULT_HENAN_GROUP_MARKER, {
          organization,
          isAdministrator,
        }).sections.flatMap((section) =>
          section.groups.map((group) => [group.id, group.canToggle]),
        ),
      );
    expect(permissions('headquarters')).toEqual({ a: true, b: false, c: false, d: false });
    expect(permissions('henan')).toEqual({ a: false, b: true, c: false, d: false });
    expect(permissions('headquarters', true)).toEqual({ a: true, b: true, c: true, d: true });
  });
  it('已登记的组织优先，待绑定的小组不会因为旧备注归入中心', () => {
    const groups = [
      {
        id: 'old',
        name: '已绑定',
        description: '河南自招团队成员',
        tenantId: 'shanghai_recruitment',
      },
      { id: 'pending', name: '待绑定', description: '河南自招团队成员', tenantId: null },
    ];
    expect(
      summarizeHostingGroups(groups, [], DEFAULT_HENAN_GROUP_MARKER).sections.map((g) => g.name),
    ).toEqual(['上海自招团队', '归属待确认']);
  });
});
