import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { ConfigService } from '@nestjs/config';
import { RoomService } from '@channels/wecom/room/room.service';

describe('GroupResolverService', () => {
  let service: GroupResolverService;
  let mockRoomService: { getRoomSimpleList: jest.Mock };

  beforeEach(() => {
    const mockConfigService = {
      get: jest.fn().mockReturnValue('艾酱:test-token'),
    };
    mockRoomService = {
      getRoomSimpleList: jest.fn(),
    };

    service = new GroupResolverService(
      mockConfigService as unknown as ConfigService,
      mockRoomService as unknown as RoomService,
    );
  });

  describe('parseLabels', () => {
    it('应解析兼职群标签（三标签：类型+城市+行业）', () => {
      const result = service.parseLabels([
        { id: '1', name: '兼职群' },
        { id: '2', name: '上海' },
        { id: '3', name: '餐饮' },
      ]);
      expect(result).toEqual({ type: '兼职群', city: '上海', industry: '餐饮' });
    });

    it('应解析抢单群标签（两标签：类型+城市）', () => {
      const result = service.parseLabels([
        { id: '1', name: '抢单群' },
        { id: '2', name: '武汉' },
      ]);
      expect(result).toEqual({ type: '抢单群', city: '武汉', industry: undefined });
    });

    it('抢单群的第三个标签不应被当成行业', () => {
      const result = service.parseLabels([
        { id: '1', name: '抢单群' },
        { id: '2', name: '景德镇' },
        { id: '3', name: '上饶' },
      ]);
      expect(result).toEqual({ type: '抢单群', city: '景德镇', industry: undefined });
    });

    it('应解析零售行业标签', () => {
      const result = service.parseLabels([
        { id: '1', name: '兼职群' },
        { id: '2', name: '上海' },
        { id: '3', name: '零售' },
      ]);
      expect(result).toEqual({ type: '兼职群', city: '上海', industry: '零售' });
    });

    it('应兼容兼职群行业和城市标签反序', () => {
      const result = service.parseLabels([
        { id: '1', name: '兼职群' },
        { id: '2', name: '餐饮' },
        { id: '3', name: '常州' },
      ]);
      expect(result).toEqual({ type: '兼职群', city: '常州', industry: '餐饮' });
    });

    it('应解析店长群标签', () => {
      const result = service.parseLabels([
        { id: '1', name: '店长群' },
        { id: '2', name: '成都' },
      ]);
      expect(result).toEqual({ type: '店长群', city: '成都', industry: undefined });
    });

    it('空标签数组应返回 null', () => {
      expect(service.parseLabels([])).toBeNull();
    });

    it('只有一个标签应返回 null', () => {
      expect(service.parseLabels([{ id: '1', name: '兼职群' }])).toBeNull();
    });

    it('未知群类型应返回 null', () => {
      expect(
        service.parseLabels([
          { id: '1', name: '合作群' },
          { id: '2', name: '上海' },
        ]),
      ).toBeNull();
    });
  });

  describe('resolveGroups', () => {
    const makeRoom = (memberCount: number) => ({
      wxid: 'room-1',
      topic: '独立客&上海餐饮兼职①群',
      chatId: 'chat-1',
      botInfo: { wxid: 'bot-im-1', weixin: 'bot-user-1', nickName: 'bot' },
      labels: [
        { id: '1', name: '兼职群' },
        { id: '2', name: '上海' },
        { id: '3', name: '餐饮' },
      ],
      memberCount,
    });

    const makeListResponse = (memberCount: number) => ({
      data: {
        data: [makeRoom(memberCount)],
        page: { total: 1 },
      },
    });

    it('forceRefresh should bypass cached group member counts', async () => {
      mockRoomService.getRoomSimpleList
        .mockResolvedValueOnce(makeListResponse(50))
        .mockResolvedValueOnce(makeListResponse(275));

      const cached = await service.resolveGroups('兼职群');
      const refreshed = await service.resolveGroups('兼职群', { forceRefresh: true });

      expect(cached[0].memberCount).toBe(50);
      expect(refreshed[0].memberCount).toBe(275);
      expect(mockRoomService.getRoomSimpleList).toHaveBeenCalledTimes(2);
    });

    it('应解析小组接口返回的兼职群错序标签', async () => {
      mockRoomService.getRoomSimpleList.mockResolvedValueOnce({
        data: {
          data: [
            {
              wxid: 'R:10842449668559208',
              topic: '独立客&苏州餐饮兼职群',
              chatId: '6a0d6047536c965402056685',
              botInfo: { wxid: '1688855974513959', weixin: 'bot-user-1', nickName: '高雅琪' },
              labels: [
                { id: '1', name: '兼职群' },
                { id: '2', name: '餐饮' },
                { id: '3', name: '苏州' },
              ],
              memberCount: 17,
            },
          ],
          page: { total: 1 },
        },
      });

      const groups = await service.resolveGroups('兼职群', { forceRefresh: true });

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        imRoomId: 'R:10842449668559208',
        groupName: '独立客&苏州餐饮兼职群',
        city: '苏州',
        industry: '餐饮',
        tag: '兼职群',
        labels: ['兼职群', '餐饮', '苏州'],
        memberCount: 17,
      });
    });
  });
});
