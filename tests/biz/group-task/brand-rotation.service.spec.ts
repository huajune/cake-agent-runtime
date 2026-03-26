import { BrandRotationService } from '@biz/group-task/services/brand-rotation.service';

describe('BrandRotationService', () => {
  let service: BrandRotationService;
  let mockRedis: Record<string, jest.Mock>;
  const store: Record<string, string> = {};

  beforeEach(() => {
    mockRedis = {
      get: jest.fn((key: string) => store[key] || null),
      setex: jest.fn((key: string, _ttl: number, value: string) => {
        store[key] = value;
      }),
      del: jest.fn((...keys: string[]) => {
        keys.forEach((k) => delete store[k]);
        return keys.length;
      }),
    };

    // 清空 store
    Object.keys(store).forEach((k) => delete store[k]);

    service = new BrandRotationService(mockRedis as any);
  });

  describe('getNextBrand', () => {
    it('首次应返回第一个品牌', async () => {
      const result = await service.getNextBrand('group-1', ['必胜客', '麦当劳', '大米先生']);
      expect(result).toBe('必胜客');
    });

    it('已推过的品牌应跳过', async () => {
      store['group-task:brand-history:group-1'] = JSON.stringify(['必胜客']);

      const result = await service.getNextBrand('group-1', ['必胜客', '麦当劳', '大米先生']);
      expect(result).toBe('麦当劳');
    });

    it('已推过两个品牌应返回第三个', async () => {
      store['group-task:brand-history:group-1'] = JSON.stringify(['必胜客', '麦当劳']);

      const result = await service.getNextBrand('group-1', ['必胜客', '麦当劳', '大米先生']);
      expect(result).toBe('大米先生');
    });

    it('全部推完后应重置轮转并返回第一个', async () => {
      store['group-task:brand-history:group-1'] = JSON.stringify([
        '必胜客',
        '麦当劳',
        '大米先生',
      ]);

      const result = await service.getNextBrand('group-1', ['必胜客', '麦当劳', '大米先生']);
      expect(result).toBe('必胜客');
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('空品牌列表应返回 null', async () => {
      const result = await service.getNextBrand('group-1', []);
      expect(result).toBeNull();
    });
  });

  describe('recordPushedBrand', () => {
    it('应记录品牌到历史', async () => {
      await service.recordPushedBrand('group-1', '必胜客');
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'group-task:brand-history:group-1',
        expect.any(Number),
        JSON.stringify(['必胜客']),
      );
    });

    it('应追加到已有历史', async () => {
      store['group-task:brand-history:group-1'] = JSON.stringify(['必胜客']);

      await service.recordPushedBrand('group-1', '麦当劳');
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'group-task:brand-history:group-1',
        expect.any(Number),
        JSON.stringify(['必胜客', '麦当劳']),
      );
    });
  });
});
