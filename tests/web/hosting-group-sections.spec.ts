import { summarizeHostingGroups } from '../../web/src/view/hosting/list/group-sections';

describe('托管小组按登记的组织汇总', () => {
  const groups = [
    {
      id: 'a',
      name: '一组',
      tenantId: 'supplier',
      tenantName: '新组织名',
      description: '河南自招团队成员',
    },
    { id: 'b', name: '二组', tenantId: 'supplier', tenantName: '新组织名' },
    { id: 'c', name: '三组', tenantId: 'other', tenantName: '新组织名' },
    { id: 'd', name: '待绑定', description: '上海智能体组内部成员' },
  ];
  it('同名组织保持独立，备注完整保留，旧备注不能分配租户', () => {
    const summary = summarizeHostingGroups(groups, ['a', 'a', 'outside']);
    expect(summary.sections.map((s) => [s.id, s.name, s.groups.length, s.blocked])).toEqual([
      ['supplier', '新组织名', 2, 1],
      ['other', '新组织名', 1, 0],
      [null, '归属待确认', 1, 0],
    ]);
    expect(summary.sections[0].groups[0].note).toBe('河南自招团队成员');
    expect(summary.total).toBe(4);
    expect(summary.blockedCount).toBe(1);
  });
  it('员工仅可操作本组织，管理员可操作全部', () => {
    const allowed = (isAdministrator: boolean) =>
      summarizeHostingGroups(groups, [], {
        organization: 'supplier',
        isAdministrator,
      }).sections.flatMap((s) => s.groups.filter((g) => g.canToggle).map((g) => g.id));
    expect(allowed(false)).toEqual(['a', 'b']);
    expect(allowed(true)).toEqual(['a', 'b', 'c', 'd']);
  });
});
