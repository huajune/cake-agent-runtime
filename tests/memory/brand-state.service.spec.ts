/**
 * BrandStateService 测试（spec §14.2 会话测试的存取/seed/补写部分）。
 */

import { BrandStateService } from '@memory/services/brand-state.service';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';

const catalog = [
  { id: 1, name: '肯德基', aliases: ['KFC'] },
  { id: 2, name: '麦当劳', aliases: ['金拱门'] },
  { id: 3, name: '大米先生', aliases: [] },
  { id: 10311, name: 'Zara Home', aliases: ['zh'] },
];

const positive = (name: string, brandId: number | null = null): BrandResolution => ({
  canonicalName: name,
  brandId,
  matchedText: name,
  sourceText: name,
  source: 'user_text',
  matchType: 'canonical_exact',
  intentPolarity: 'positive',
  confidence: 0.95,
  ambiguous: false,
});

/** 冲突别名歧义结果：canonicalName 为空、候选多品牌（如「小龙」→ 小龙坎/小龙翻大江）。 */
const ambiguousMention = (alias: string, sourceText: string): BrandResolution => ({
  canonicalName: null,
  brandId: null,
  matchedText: alias,
  sourceText,
  source: 'user_text',
  matchType: 'alias_containment',
  intentPolarity: 'positive',
  confidence: 0.4,
  ambiguous: true,
  candidates: [
    { canonicalName: '小龙坎', brandId: 8 },
    { canonicalName: '小龙翻大江', brandId: 9 },
  ],
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
        contactName: '小王 肯德基五角场',
      });
      expect(ctx.persisted).toBe(false);
      expect(ctx.state.currentBrand?.canonicalName).toBe('肯德基');
      expect(ctx.nicknameBrands).toEqual(['肯德基']);
    });

    it('未命中品牌库的昵称（Gattouzo）不产生 seed', async () => {
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
        contactName: 'Gattouzo',
      });
      expect(ctx.state.currentBrand).toBeNull();
      expect(ctx.nicknameBrands).toEqual([]);
    });

    it('2-3 位纯英文昵称即使唯一命中品牌别名也不产生 seed', async () => {
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
        contactName: 'zh',
      });
      expect(ctx.state.currentBrand).toBeNull();
      expect(ctx.nicknameBrands).toEqual([]);
    });

    it('懒迁移已退役（§19.6）：无持久化状态时只按昵称 seed 初始化', async () => {
      // 旧 preferences.brands 末位品牌档已删除——生产 Redis 实测迁移窗口耗尽
      // （889 会话仅 1 个可迁且 TTL <17h），旧存储值不再影响初始化。
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
        contactName: '小王 肯德基',
      });
      expect(ctx.state.currentBrand?.canonicalName).toBe('肯德基');
    });

    it('brand_state 已存在（含被 browse_all 清成空值）永不重新 seed', async () => {
      const cleared = { currentBrand: null, excludedBrands: [], updatedAtMs: 1000 };
      const ctx = await service.deriveTurnBrandContext({
        persisted: cleared,
        contactName: '小王 肯德基',
      });
      expect(ctx.persisted).toBe(true);
      // 昵称品牌不再进入状态："清空后被昵称锁回"在结构上不可能发生
      expect(ctx.state.currentBrand).toBeNull();
    });

    it('无昵称品牌 → 空状态初始化', async () => {
      const ctx = await service.deriveTurnBrandContext({
        persisted: null,
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
      });
      const event = mockTracer.emit.mock.calls[0][0];
      expect(event.type).toBe('brand_state_change');
      expect(event.prev.currentBrand.canonicalName).toBe('肯德基');
      expect(event.next.currentBrand.canonicalName).toBe('麦当劳');
      expect(event.triggers[0]).toMatchObject({ canonicalName: '麦当劳', polarity: 'positive' });
    });
  });

  describe('brand_resolution_ambiguous（歧义现场留痕，§18 观测债）', () => {
    const persisted = {
      currentBrand: { canonicalName: '肯德基', brandId: 1 },
      excludedBrands: [],
      updatedAtMs: 1000,
    };

    it('纯歧义轮：状态不变也发 ambiguous 事件（此前该场景整档零留痕），不发 state_change', async () => {
      const outcome = await service.applyTurnResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [ambiguousMention('小龙', '想去小龙那边上班')],
        persistedBrandState: persisted,
      });
      expect(outcome.changed).toBe(false);
      expect(mockRedisStore.patchHash).not.toHaveBeenCalled();
      expect(mockTracer.emit).toHaveBeenCalledTimes(1);
      const event = mockTracer.emit.mock.calls[0][0];
      expect(event.type).toBe('brand_resolution_ambiguous');
      expect(event.late).toBe(false);
      expect(event.items).toEqual([
        expect.objectContaining({
          matchedText: '小龙',
          sourceText: '想去小龙那边上班',
          candidates: [
            { canonicalName: '小龙坎', brandId: 8 },
            { canonicalName: '小龙翻大江', brandId: 9 },
          ],
        }),
      ]);
    });

    it('歧义与状态变化同轮：两个事件都发，ambiguous 只含歧义项', async () => {
      await service.applyTurnResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [ambiguousMention('小龙', '小龙和麦当劳都行'), positive('麦当劳', 2)],
        persistedBrandState: persisted,
      });
      const types = mockTracer.emit.mock.calls.map((c) => c[0].type);
      expect(types).toContain('brand_resolution_ambiguous');
      expect(types).toContain('brand_state_change');
      const ambiguousEvent = mockTracer.emit.mock.calls.find(
        (c) => c[0].type === 'brand_resolution_ambiguous',
      )![0];
      expect(ambiguousEvent.items).toHaveLength(1);
    });

    it('无歧义结果不发事件（不给事件表添噪音）', async () => {
      await service.applyTurnResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [positive('肯德基', 1)],
        persistedBrandState: persisted,
      });
      const types = mockTracer.emit.mock.calls.map((c) => c[0].type);
      expect(types).not.toContain('brand_resolution_ambiguous');
    });

    it('图片补写路径即使 dropped_expired 也留歧义痕（late=true）', async () => {
      mockRedisStore.getHash.mockResolvedValue({
        brand_state: { currentBrand: null, excludedBrands: [], updatedAtMs: 5000 },
      });
      const outcome = await service.applyLateImageResolutions({
        corpId: 'c',
        userId: 'u',
        sessionId: 's',
        resolutions: [
          { ...ambiguousMention('小龙', '门店招牌写着小龙'), source: 'image_description' },
        ],
        resolutionTurnMs: 4000,
      });
      expect(outcome).toBe('dropped_expired');
      expect(mockTracer.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'brand_resolution_ambiguous', late: true }),
      );
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
