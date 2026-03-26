import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';

describe('GroupResolverService', () => {
  let service: GroupResolverService;

  beforeEach(() => {
    const mockConfigService = {
      get: jest.fn().mockReturnValue('艾酱:test-token'),
    };
    const mockRoomService = {
      getRoomSimpleList: jest.fn(),
    };

    service = new GroupResolverService(mockConfigService as any, mockRoomService as any);
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

    it('应解析零售行业标签', () => {
      const result = service.parseLabels([
        { id: '1', name: '兼职群' },
        { id: '2', name: '上海' },
        { id: '3', name: '零售' },
      ]);
      expect(result).toEqual({ type: '兼职群', city: '上海', industry: '零售' });
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
});
