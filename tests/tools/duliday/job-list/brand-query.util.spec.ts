/**
 * duliday_job_list 品牌查询计划测试（spec §14.3 工具测试）。
 */

import type { BrandItem } from '@/sponge/sponge.types';
import { buildBrandQueryPlan, toBrandQueryMeta } from '@tools/duliday/job-list/brand-query.util';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';

const catalog: BrandItem[] = [
  { id: 10001, name: '肯德基', aliases: ['KFC'] },
  { id: 10002, name: '麦当劳', aliases: ['金拱门'] },
  { id: 10003, name: '瑞幸咖啡', aliases: ['瑞幸'] },
  { id: 10004, name: '拉瓦萨', aliases: [] },
  { id: 10027, name: 'M Stand', aliases: ['mstand'] },
  { id: 10005, name: '大米先生', aliases: [] },
  { id: 10008, name: '小龙坎', aliases: ['小龙'] },
  { id: 10009, name: '小龙翻大江', aliases: ['小龙'] },
];

const stateWith = (
  current: { canonicalName: string; brandId: number | null } | null,
  excluded: Array<{ canonicalName: string; brandId: number | null }> = [],
): SessionBrandState => ({ currentBrand: current, excludedBrands: excluded });

describe('buildBrandQueryPlan（§8.1 组合规则）', () => {
  it('所有别名统一转标准品牌，可用时优先使用品牌 ID', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: ['KFC', '金拱门'],
      brandIdList: [],
      sessionBrandState: null,
      catalog,
    });
    expect(plan.filterMode).toBe('enforce');
    expect(plan.brandSource).toBe('model_input');
    expect(plan.applied.map((b) => b.canonicalName).sort()).toEqual(['肯德基', '麦当劳']);
    // 可得 ID 的品牌优先走 brandIdList，不留别名
    expect(plan.queryBrandIdList.sort()).toEqual([10001, 10002]);
    expect(plan.queryBrandAliasList).toEqual([]);
  });

  it('目录无 ID 的品牌保留标准名走 brandAliasList', () => {
    const noIdCatalog: BrandItem[] = [{ name: '肯德基', aliases: ['KFC'] }];
    const plan = buildBrandQueryPlan({
      brandAliasList: ['KFC'],
      brandIdList: [],
      sessionBrandState: null,
      catalog: noIdCatalog,
    });
    expect(plan.queryBrandIdList).toEqual([]);
    expect(plan.queryBrandAliasList).toEqual(['肯德基']);
  });

  it('模型显式 brandIdList 原样采信并回查名称', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [10001],
      sessionBrandState: null,
      catalog,
    });
    expect(plan.filterMode).toBe('enforce');
    expect(plan.brandSource).toBe('model_input');
    expect(plan.queryBrandIdList).toEqual([10001]);
    expect(plan.applied[0]).toEqual({ canonicalName: '肯德基', brandId: 10001 });
  });

  it('冲突别名不得强制查询（进 rejected(ambiguous)）', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: ['小龙'],
      brandIdList: [],
      sessionBrandState: null,
      catalog,
    });
    expect(plan.allRejected).toBe(true);
    expect(plan.rejected[0].reason).toBe('ambiguous');
    expect(plan.queryBrandIdList).toEqual([]);
    expect(plan.queryBrandAliasList).toEqual([]);
  });

  it('未命中昵称/臆造品牌不得进入工具过滤（rejected(unmatched) + allRejected）', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: ['Gattouzo'],
      brandIdList: [],
      sessionBrandState: stateWith(null),
      catalog,
    });
    expect(plan.allRejected).toBe(true);
    expect(plan.rejected).toEqual([{ input: 'Gattouzo', reason: 'unmatched' }]);
  });

  describe('会话品牌兜底（仅 currentBrand 一档）', () => {
    it('列表空 + mode 未传 → currentBrand 按 enforce 执行并披露 clear 出口', () => {
      const plan = buildBrandQueryPlan({
        brandAliasList: [],
        brandIdList: [],
        sessionBrandState: stateWith({ canonicalName: '大米先生', brandId: 10005 }),
        catalog,
      });
      expect(plan.filterMode).toBe('enforce');
      expect(plan.brandSource).toBe('session_state');
      expect(plan.queryBrandIdList).toEqual([10005]);
      expect(plan.disclosure).toContain('大米先生');
      expect(plan.disclosure).toContain("brandFilterMode='clear'");
    });

    it('excludedBrands 不经兜底回流（兜底只读 currentBrand）', () => {
      const plan = buildBrandQueryPlan({
        brandAliasList: [],
        brandIdList: [],
        sessionBrandState: stateWith(null, [{ canonicalName: '肯德基', brandId: 10001 }]),
        catalog,
      });
      expect(plan.brandSource).toBe('none');
      expect(plan.queryBrandIdList).toEqual([]);
      expect(plan.queryBrandAliasList).toEqual([]);
    });

    it("filterMode='clear' 时不触发任何兜底（0 结果放宽重查不被拉回原品牌）", () => {
      const plan = buildBrandQueryPlan({
        brandAliasList: [],
        brandIdList: [],
        brandFilterMode: 'clear',
        sessionBrandState: stateWith({ canonicalName: '大米先生', brandId: 10005 }),
        catalog,
      });
      expect(plan.filterMode).toBe('clear');
      expect(plan.brandSource).toBe('none');
      expect(plan.queryBrandIdList).toEqual([]);
    });

    it('browse_all 同样无品牌查询（语义与审计归因不同于 clear）', () => {
      const plan = buildBrandQueryPlan({
        brandAliasList: [],
        brandIdList: [],
        brandFilterMode: 'browse_all',
        sessionBrandState: stateWith({ canonicalName: '大米先生', brandId: 10005 }),
        catalog,
      });
      expect(plan.filterMode).toBe('browse_all');
      expect(plan.brandSource).toBe('none');
    });

    it('用户当前明确品牌（模型显式传参）优先于会话品牌兜底', () => {
      const plan = buildBrandQueryPlan({
        brandAliasList: ['肯德基'],
        brandIdList: [],
        sessionBrandState: stateWith({ canonicalName: '大米先生', brandId: 10005 }),
        catalog,
      });
      expect(plan.brandSource).toBe('model_input');
      expect(plan.applied.map((b) => b.canonicalName)).toEqual(['肯德基']);
    });
  });

  it('列表空 + enforce/exclude 是矛盾组合，报错', () => {
    for (const mode of ['enforce', 'exclude'] as const) {
      const plan = buildBrandQueryPlan({
        brandAliasList: [],
        brandIdList: [],
        brandFilterMode: mode,
        sessionBrandState: null,
        catalog,
      });
      expect(plan.error).toBe('empty_list_with_mode');
    }
  });

  it('exclude：品牌进本地排除目标，查询本身不带品牌条件', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: ['肯德基'],
      brandIdList: [],
      brandFilterMode: 'exclude',
      sessionBrandState: null,
      catalog,
    });
    expect(plan.filterMode).toBe('exclude');
    expect(plan.excludeBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
    expect(plan.queryBrandIdList).toEqual([]);
    expect(plan.queryBrandAliasList).toEqual([]);
  });

  it('裸品类词"咖啡"按品类扩张并减去 excludedBrands（不再收敛到默认品牌）', () => {
    // 2026-07-20 产品裁定撤除 defaultBrand 后，"咖啡"与"其他咖啡品牌"走同一条展开路径。
    const plan = buildBrandQueryPlan({
      brandAliasList: ['咖啡'],
      brandIdList: [],
      sessionBrandState: stateWith(null, [{ canonicalName: '瑞幸咖啡', brandId: 10003 }]),
      catalog,
    });
    expect(plan.applied.map((b) => b.canonicalName).sort()).toEqual(['M Stand', '拉瓦萨']);
    expect(plan.categoryExcludedRemoved).toEqual(['瑞幸咖啡']);
  });

  it('其他咖啡品牌仍按品类扩张并减去 excludedBrands', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: ['其他咖啡品牌'],
      brandIdList: [],
      sessionBrandState: stateWith(null, [{ canonicalName: '瑞幸咖啡', brandId: 10003 }]),
      catalog,
    });
    expect(plan.applied.map((b) => b.canonicalName).sort()).toEqual(['M Stand', '拉瓦萨']);
    expect(plan.categoryExcludedRemoved).toEqual(['瑞幸咖啡']);
  });

  it('显式点名的品牌不减 excludedBrands（显式表达优先，收尾会解除排斥）', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: ['瑞幸'],
      brandIdList: [],
      sessionBrandState: stateWith(null, [{ canonicalName: '瑞幸咖啡', brandId: 10003 }]),
      catalog,
    });
    expect(plan.applied.map((b) => b.canonicalName)).toEqual(['瑞幸咖啡']);
    expect(plan.categoryExcludedRemoved).toEqual([]);
  });
});

describe('toBrandQueryMeta（§11 类型化 brand 小节）', () => {
  it('queryMeta 正确记录 filterMode/brandSource/applied/rejected/fuzzySuggestions', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: ['KFC', 'Gattouzo'],
      brandIdList: [],
      sessionBrandState: null,
      catalog,
    });
    const meta = toBrandQueryMeta(plan, [
      { brandName: '成都你六姐', inputAlias: '刘姐妹', score: 0.8 },
    ]);
    expect(meta.filterMode).toBe('enforce');
    expect(meta.brandSource).toBe('model_input');
    expect(meta.appliedBrandIds).toEqual([10001]);
    expect(meta.appliedCanonicalNames).toEqual(['肯德基']);
    expect(meta.rejected).toEqual([{ input: 'Gattouzo', reason: 'unmatched' }]);
    expect(meta.fuzzySuggestions).toHaveLength(1);
  });

  it('首轮由昵称 seed 而来的兜底记为 session_state', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [],
      // 首轮 seed 状态：昵称品牌经 deriveTurnBrandContext seed 进 currentBrand
      sessionBrandState: stateWith({ canonicalName: '肯德基', brandId: 10001 }),
      catalog,
    });
    expect(toBrandQueryMeta(plan).brandSource).toBe('session_state');
    expect(toBrandQueryMeta(plan).appliedCanonicalNames).toEqual(['肯德基']);
  });
});
