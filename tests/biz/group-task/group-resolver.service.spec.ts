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
    const labels = (...names: string[]) => names.map((name) => ({ id: name, name }));

    it.each([
      ['上海', '餐饮', '兼职群'],
      ['餐饮', '上海', '兼职群'],
      ['上海', '兼职群', '餐饮'],
      ['餐饮', '兼职群', '上海'],
      ['零售', '上海', '兼职群', '餐饮'],
    ])('按名称识别兼职类型和行业（%s, %s, %s）', (...names) => {
      expect(service.parseLabels(labels(...names))).toEqual({
        type: '兼职群',
        city: '上海',
        industry: '餐饮',
      });
    });

    it('支持多地区抢单群和只标类型的店长群', () => {
      expect(service.parseLabels(labels('景德镇', '抢单群', '上饶'))).toMatchObject({
        type: '抢单群',
        city: '景德镇',
      });
      expect(service.parseLabels(labels('店长群'))).toMatchObject({ type: '店长群', city: '全国' });
      expect(service.parseLabels(labels('成都', '店长群'))).toMatchObject({
        type: '店长群',
        city: '成都',
      });
    });

    it('排除摘标、类型冲突、缺少兼职地区的群', () => {
      expect(service.parseLabels(labels('武汉', '原抢单群'))).toBeNull();
      expect(service.parseLabels(labels('上海', '兼职群', '抢单群'))).toBeNull();
      expect(service.parseLabels(labels('餐饮', '兼职群'))).toBeNull();
      expect(service.parseLabels(labels('上海', '未分类标签', '兼职群'))).toBeNull();
    });

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

    it('按群 ID 核对最新标签，不受名单缓存或同名群影响', async () => {
      const room = {
        ...makeRoom(50),
        topic: '武汉抢单群',
        labels: [
          { id: '1', name: '武汉' },
          { id: '2', name: '抢单群' },
        ],
      };
      mockRoomService.getRoomSimpleList.mockResolvedValueOnce({ code: 0, data: [room] });
      const [group] = await service.resolveGroups('抢单群');
      mockRoomService.getRoomSimpleList
        .mockResolvedValueOnce({ code: 0, data: [room] })
        .mockResolvedValueOnce({
          code: 0,
          data: [
            { ...room, labels: room.labels.slice(0, 1) },
            { ...room, wxid: 'other' },
          ],
        })
        .mockResolvedValueOnce({ code: 401, data: [] });
      await expect(service.hasCurrentTag(group, '抢单群')).resolves.toBe(true);
      await expect(service.hasCurrentTag(group, '抢单群')).resolves.toBe(false);
      await expect(service.hasCurrentTag(group, '抢单群')).rejects.toThrow();
      expect(mockRoomService.getRoomSimpleList).toHaveBeenLastCalledWith(
        'test-token',
        0,
        1,
        'room-1',
      );
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
