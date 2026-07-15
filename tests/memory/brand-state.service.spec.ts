/**
 * BrandStateService 测试（spec §14.2 会话测试的存取/seed/补写部分）。
 */

import { BrandStateService } from '@memory/services/brand-state.service';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';
import type { SessionFacts } from '@memory/types/session-facts.types';

const catalog = [
  { id: 1, name: '肯德基', aliases: ['KFC'] },
  { id: 2, name: '麦当劳', aliases: ['金拱门'] },
  { id: 3, name: '大米先生', aliases: [] },
];

function makeFactsWithBrands(brands: string[] | null): SessionFacts {
  return {
    interview_info: {},
    preferences: {
      brands: brands
        ? {
            value: brands,
            confidence: 'high',
            source: 'rule',
            evidence: 'test',
            extractedAt: new Date().toISOString(),
          }
        : null,
    },
    reasoning: '',
  } as unknown as SessionFacts;
}

const positive = (name: string, brandId: number | null = null): BrandResolution => ({
  canonicalName: name,
  brandId,
  matchedText: name,
  source: 'user_text',
  matchType: 'canonical_exact',
  intentPolarity: 'positive',
  confidence: 0.95,
  ambiguous: false,
});

describe('BrandStateService', () => {
  const mockRedisStore = {
    getHash: jest.fn(),
    patchHash: jest.fn().mockResolvedValue(undefined),
  };
  const mockConfig = { sessionTtl: 3600 };
  const mockSponge = { fetchBrandList: jest.fn().mockResolvedValue(catalog) };
  const mockTracer = { emit: jest.fn() };

  let service: BrandStateService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisStore.getHash.mockResolvedValue(null);
    mockSponge.fetchBrandList.mockResolvedValue(catalog);
    service = new BrandStateService(
      mockRedisStore as never,
      mockConfig as never,
      mockSponge as never,
      mockTracer as never,
    );
  });

  describe('deriveTurnBrandContext（首轮 seed，§9.4）', () => {
    it('brand_state 不存在且昵称品牌唯一命中 → seed 为 currentBrand（首轮即生效）', async () => {
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
        facts: null,
        contactName: '小王 肯德基五角场',
      });
      expect(ctx.persisted).toBe(false);
      expect(ctx.state.currentBrand?.canonicalName).toBe('肯德基');
      expect(ctx.nicknameBrands).toEqual(['肯德基']);
    });

    it('未命中品牌库的昵称（Gattouzo）不产生 seed', async () => {
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
        facts: null,
        contactName: 'Gattouzo',
      });
      expect(ctx.state.currentBrand).toBeNull();
      expect(ctx.nicknameBrands).toEqual([]);
    });

    it('旧 preferences.brands 末位品牌优先于昵称 seed（对话表达时点更晚）', async () => {
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
        facts: makeFactsWithBrands(['肯德基', '大米先生']),
        contactName: '小王 肯德基',
      });
      expect(ctx.state.currentBrand?.canonicalName).toBe('大米先生');
      expect(ctx.state.currentBrand?.brandId).toBe(3);
    });

    it('brand_state 已存在（含被 browse_all 清成空值）永不重新 seed', async () => {
      const cleared = { currentBrand: null, excludedBrands: [], updatedAtMs: 1000 };
      const ctx = await service.deriveTurnBrandContext({
        persisted: cleared,
        facts: null,
        contactName: '小王 肯德基',
      });
      expect(ctx.persisted).toBe(true);
      // 昵称品牌不再进入状态："清空后被昵称锁回"在结构上不可能发生
      expect(ctx.state.currentBrand).toBeNull();
    });

    it('空数组旧事实 + 无昵称品牌 → 空状态初始化', async () => {
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
        facts: makeFactsWithBrands([]),
        contactName: undefined,
      });
      expect(ctx.state).toEqual({ currentBrand: null, excludedBrands: [] });
    });
  });

  describe('applyTurnResolutions（收尾统一写入，§9.1）', () => {
    it('首次初始化必落盘（seed 只此一次的锚点是字段存在），单字段原子替换', async () => {
      const outcome = await service.applyTurnResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [],
        contactName: '小王 肯德基',
        persistedBrandState: null,
        facts: null,
      });
      expect(outcome.initialized).toBe(true);
      expect(mockRedisStore.patchHash).toHaveBeenCalledTimes(1);
      const [key, patch] = mockRedisStore.patchHash.mock.calls[0];
      expect(key).toBe('factsv2:c:u:s');
      // 只写 brand_state 单字段（禁止拆成多个 hash 字段，§9.1）
      expect(Object.keys(patch)).toEqual(['brand_state']);
      expect(patch.brand_state.currentBrand.canonicalName).toBe('肯德基');
      expect(typeof patch.brand_state.updatedAtMs).toBe('number');
      expect(mockTracer.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'brand_state_change', initialized: true }),
      );
    });

    it('状态已存在且无变化时不写不发事件', async () => {
      const persisted = {
        currentBrand: { canonicalName: '肯德基', brandId: 1 },
        excludedBrands: [],
        updatedAtMs: 1000,
      };
      const outcome = await service.applyTurnResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [positive('肯德基', 1)],
        persistedBrandState: persisted,
        facts: null,
      });
      expect(outcome.changed).toBe(false);
      expect(mockRedisStore.patchHash).not.toHaveBeenCalled();
      expect(mockTracer.emit).not.toHaveBeenCalled();
    });

    it('状态变化时写回并发 brand_state_change 事件（前后快照 + triggers）', async () => {
      const persisted = {
        currentBrand: { canonicalName: '肯德基', brandId: 1 },
        excludedBrands: [],
        updatedAtMs: 1000,
      };
      await service.applyTurnResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [positive('麦当劳', 2)],
        persistedBrandState: persisted,
        facts: null,
      });
      const event = mockTracer.emit.mock.calls[0][0];
      expect(event.type).toBe('brand_state_change');
      expect(event.prev.currentBrand.canonicalName).toBe('肯德基');
      expect(event.next.currentBrand.canonicalName).toBe('麦当劳');
      expect(event.triggers[0]).toMatchObject({ canonicalName: '麦当劳', polarity: 'positive' });
    });
  });

  describe('applyLateImageResolutions（异步补写，§10.3）', () => {
    it('补写轮次早于状态最后变更 → dropped_expired，排斥不被赦免', async () => {
      mockRedisStore.getHash.mockResolvedValue({
        brand_state: {
          currentBrand: null,
          excludedBrands: [{ canonicalName: 'M Stand', brandId: 5 }],
          updatedAtMs: 5000,
        },
      });
      const outcome = await service.applyLateImageResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [{ ...positive('M Stand', 5), source: 'image_description' }],
        resolutionTurnMs: 4000,
      });
      expect(outcome).toBe('dropped_expired');
      expect(mockRedisStore.patchHash).not.toHaveBeenCalled();
    });

    it('状态自补写轮次后未变更 → 应用并落状态（late 事件标记）', async () => {
      mockRedisStore.getHash.mockResolvedValue({
        brand_state: { currentBrand: null, excludedBrands: [], updatedAtMs: 3000 },
      });
      const outcome = await service.applyLateImageResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [{ ...positive('M Stand', 5), source: 'image_description' }],
        resolutionTurnMs: 4000,
      });
      expect(outcome).toBe('applied');
      expect(mockRedisStore.patchHash).toHaveBeenCalledTimes(1);
      expect(mockTracer.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'brand_state_change', late: true }),
      );
    });

    it('无品牌信号时 noop', async () => {
      const outcome = await service.applyLateImageResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [],
        resolutionTurnMs: 4000,
      });
      expect(outcome).toBe('noop');
      expect(mockRedisStore.getHash).not.toHaveBeenCalled();
    });
  });
});
