import type { GroupContext } from '@biz/group-task/group-task.types';
import {
  extractEnterpriseRoomId,
  extractEnterpriseRoomIds,
  extractEnterpriseRooms,
  extractMemberCount,
  parseCount,
  refreshMemberCountsFromEnterpriseList,
} from '@tools/utils/enterprise-room-count.util';

describe('enterprise-room-count.util', () => {
  const makeGroup = (overrides: Partial<GroupContext> = {}): GroupContext => ({
    imRoomId: 'room-1',
    groupName: '上海兼职群1号',
    city: '上海',
    tag: '兼职群',
    imBotId: 'bot-1',
    token: 'token-1',
    memberCount: 50,
    ...overrides,
  });

  it('should extract enterprise rooms from common response shapes', () => {
    expect(extractEnterpriseRooms([{ imRoomId: 'room-1' }, 'bad'])).toEqual([
      { imRoomId: 'room-1' },
    ]);
    expect(
      extractEnterpriseRooms({
        data: {
          list: [{ imRoomId: 'room-2' }, null],
        },
      }),
    ).toEqual([{ imRoomId: 'room-2' }]);
    expect(extractEnterpriseRooms({ records: [{ imRoomId: 'room-3' }] })).toEqual([
      { imRoomId: 'room-3' },
    ]);
  });

  it('should extract room ids and member counts from field variants', () => {
    expect(extractEnterpriseRoomId({ wxid: ' room-1 ' })).toBe('room-1');
    expect(extractEnterpriseRoomId({ groupChatId: 'room-2' })).toBe('room-2');
    expect(extractEnterpriseRoomId({ groupChatId: ' ' })).toBeUndefined();
    expect(
      extractEnterpriseRoomIds({
        imRoomId: 'room-1',
        chatId: 'chat-1',
        roomWecomChatId: 'chat-1',
      }),
    ).toEqual(['room-1', 'chat-1']);

    expect(extractMemberCount({ member_count: '128' })).toBe(128);
    expect(extractMemberCount({ roomMemberCount: 88 })).toBe(88);
    expect(extractMemberCount({ memberList: [{}, {}, {}] })).toBe(3);
    expect(extractMemberCount({ members: [{}, {}] })).toBe(2);
    expect(extractMemberCount({ memberCount: 'unknown' })).toBeUndefined();
  });

  it('should parse finite numeric counts only', () => {
    expect(parseCount(12)).toBe(12);
    expect(parseCount('42')).toBe(42);
    expect(parseCount(Number.NaN)).toBeUndefined();
    expect(parseCount('')).toBeUndefined();
  });

  it('should call syncRoom before refreshing member counts from enterprise list', async () => {
    const roomService = {
      getEnterpriseGroupChatList: jest.fn().mockResolvedValue({
        data: [
          { imRoomId: 'room-1', member_count: '201' },
          { roomWxid: 'room-2', memberList: Array.from({ length: 80 }, () => ({})) },
        ],
      }),
      syncRoom: jest.fn().mockResolvedValue({ errcode: 0 }),
    };
    const groups = [
      makeGroup({ imRoomId: 'room-1', memberCount: 50 }),
      makeGroup({ imRoomId: 'room-2', groupName: '上海兼职群2号', memberCount: 70 }),
    ];

    const refreshed = await refreshMemberCountsFromEnterpriseList({
      groups,
      roomService,
      enterpriseToken: 'token',
    });

    expect(refreshed.map((group) => group.memberCount)).toEqual([201, 80]);
    expect(roomService.syncRoom).toHaveBeenCalledWith('token', 'bot-1');
    expect(roomService.getEnterpriseGroupChatList).toHaveBeenCalledWith('token', 1, 1000, 'bot-1');
  });

  it('should deduplicate syncRoom calls when groups share the same imBotId', async () => {
    const roomService = {
      getEnterpriseGroupChatList: jest.fn().mockResolvedValue({ data: [] }),
      syncRoom: jest.fn().mockResolvedValue({ errcode: 0 }),
    };
    const groups = [
      makeGroup({ imRoomId: 'room-1', imBotId: 'bot-1', memberCount: 50 }),
      makeGroup({ imRoomId: 'room-2', imBotId: 'bot-1', memberCount: 70 }),
    ];

    await refreshMemberCountsFromEnterpriseList({
      groups,
      roomService,
      enterpriseToken: 'token',
    });

    expect(roomService.syncRoom).toHaveBeenCalledTimes(1);
    expect(roomService.syncRoom).toHaveBeenCalledWith('token', 'bot-1');
  });

  it('should keep original counts when enterprise list API fails', async () => {
    const roomService = {
      getEnterpriseGroupChatList: jest.fn().mockRejectedValue(new Error('timeout')),
      syncRoom: jest.fn().mockResolvedValue({ errcode: 0 }),
    };
    const groups = [makeGroup({ imRoomId: 'room-1', memberCount: 50 })];

    const refreshed = await refreshMemberCountsFromEnterpriseList({
      groups,
      roomService,
      enterpriseToken: 'token',
    });

    expect(refreshed[0].memberCount).toBe(50);
  });

  it('should keep original counts when syncRoom returns a failure code', async () => {
    const roomService = {
      getEnterpriseGroupChatList: jest.fn().mockResolvedValue({
        data: [{ imRoomId: 'room-1', member_count: 200 }],
      }),
      syncRoom: jest.fn().mockResolvedValue({ errcode: -1, errmsg: 'sync failed' }),
    };
    const groups = [makeGroup({ imRoomId: 'room-1', memberCount: 185 })];

    const refreshed = await refreshMemberCountsFromEnterpriseList({
      groups,
      roomService,
      enterpriseToken: 'token',
    });

    expect(refreshed[0].memberCount).toBe(185);
    expect(roomService.getEnterpriseGroupChatList).not.toHaveBeenCalled();
  });
});
