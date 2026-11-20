import { parseHenanRoster, parseStaffRoster } from '../../src/cli/dashboard-roster';

describe('河南后台负责人名单', () => {
  const first = { name: '成员一', phone: '13800000001', groupId: 'g1' };
  it('同一人的多个 Bot 只开一个账号，发布数据仅含成员和小组身份', () => {
    expect(
      parseHenanRoster(
        {
          members: [
            { ...first, botImId: 'bot-1', dulidayToken: 'fixture-only' },
            { ...first, phone: '+8613800000001', botImId: 'bot-2', feishuOpenId: 'fixture-only' },
            { name: '成员二', phone: '13800000002', groupId: 'g2' },
          ],
        },
        true,
      ),
    ).toEqual([
      { name: '成员一', phone: '+8613800000001', groupId: 'g1' },
      { name: '成员二', phone: '+8613800000002', groupId: 'g2' },
    ]);
  });
  it('拒绝一个人配置多个小组以及一个小组重复分配', () => {
    expect(() => parseHenanRoster({ members: [first, { ...first, groupId: 'g2' }] }, true)).toThrow(
      '多个姓名或托管小组',
    );
    expect(() =>
      parseHenanRoster({ members: [first, { ...first, phone: '13800000002' }] }, true),
    ).toThrow('多个负责人');
  });
  it('旧名单可以先登记，正式开通须带负责小组', () => {
    const source = { members: [{ name: first.name, phone: first.phone }] };
    expect(parseHenanRoster(source, false)[0].groupId).toBeNull();
    expect(() => parseHenanRoster(source, true)).toThrow('缺少负责的小组');
  });
});

it('retains a configured owner without a phone and rejects duplicate cross-organization identities', () => {
  const member = {
    name: '示例',
    phone: null,
    groupId: 'sh-a',
    feishuOpenId: 'fx-a',
    organization: 'shanghai_recruitment',
  };
  expect(parseStaffRoster({ members: [{ ...member, dulidayToken: 'fixture' }, member] })).toEqual([
    member,
  ]);
  expect(() =>
    parseStaffRoster({
      members: [member, { ...member, groupId: 'hq-b', organization: 'headquarters' }],
    }),
  ).toThrow('多个小组');
});
