/**
 * duliday_job_list 品牌查询计划测试（spec §14.3 工具测试）。
 */

import type { BrandItem } from '@/sponge/sponge.types';
import {
  allRejectedAsUnmatched,
  buildBrandQueryPlan,
  findRejectedIdNeighbors,
  findUnmentionedQueryBrands,
  findUnprovenancedRejectedBrands,
  rejectedBrandIds,
  toBrandQueryMeta,
} from '@tools/job-list/brand-query.util';
import { normalizeBrandNameForComparison } from '@resolution/brand/brand-normalize';
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

describe('品牌提及集合校验', () => {
  const mentioned = (...names: string[]) => new Set(names.map(normalizeBrandNameForComparison));
  const planFor = (brandAliasList: string[], brandIdList: number[] = []) =>
    buildBrandQueryPlan({ brandAliasList, brandIdList, catalog });

  it('可靠空集合拦截真实存在但上下文未提及的品牌', () => {
    expect(findUnmentionedQueryBrands(planFor(['KFC']), mentioned(), catalog)).toEqual([
      expect.objectContaining({ canonicalName: '肯德基', brandId: 10001 }),
    ]);
  });

  it('别名与全半角/空格写法归一化后匹配同一品牌', () => {
    expect(findUnmentionedQueryBrands(planFor(['KFC']), mentioned('肯德基'), catalog)).toEqual([]);
    expect(
      findUnmentionedQueryBrands(planFor(['mstand']), mentioned('Ｍ Ｓｔａｎｄ'), catalog),
    ).toEqual([]);
  });

  it('可映射 ID 与品牌名遵守同一个集合，未知 ID 不新增出处拦截', () => {
    expect(findUnmentionedQueryBrands(planFor([], [10001]), mentioned(), catalog)).toHaveLength(1);
    expect(findUnmentionedQueryBrands(planFor([], [10001]), mentioned('肯德基'), catalog)).toEqual(
      [],
    );
    expect(findUnmentionedQueryBrands(planFor([], [99999]), mentioned(), catalog)).toEqual([]);
  });

  it.each([null, undefined])('提及集合不可用（%s）时放行', (brands) => {
    expect(findUnmentionedQueryBrands(planFor(['KFC']), brands, catalog)).toEqual([]);
  });

  it('目录不可用不新增出处拦截', () => {
    expect(findUnmentionedQueryBrands(planFor(['KFC']), mentioned(), [])).toEqual([]);
  });

  it('多个品牌逐一核验，不静默删除未提及的筛选条件', () => {
    expect(
      findUnmentionedQueryBrands(planFor(['KFC', '金拱门']), mentioned('肯德基'), catalog),
    ).toEqual([expect.objectContaining({ canonicalName: '麦当劳', brandId: 10002 })]);
  });

  it('只核验提及，不改变 exclude 极性或会话兜底', () => {
    const exclusion = buildBrandQueryPlan({
      brandAliasList: ['KFC'],
      brandIdList: [],
      brandFilterMode: 'exclude',
      catalog,
    });
    expect(findUnmentionedQueryBrands(exclusion, mentioned('肯德基'), catalog)).toEqual([]);
    const fallback = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [],
      catalog,
      sessionBrandState: stateWith({ canonicalName: '肯德基', brandId: 10001 }),
    });
    expect(findUnmentionedQueryBrands(fallback, mentioned(), catalog)).toEqual([]);
  });

  it('不把未知或歧义品牌的原有解析结果改成无出处错误', () => {
    expect(findUnmentionedQueryBrands(planFor(['小龙']), mentioned(), catalog)).toEqual([]);
    expect(findUnmentionedQueryBrands(planFor(['未知品牌']), mentioned(), catalog)).toEqual([]);
  });
});

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

describe('allRejectedAsUnmatched', () => {
  const planWith = (rejected: Array<{ input: string; reason: 'unmatched' | 'ambiguous' }>) =>
    ({ rejected }) as unknown as Parameters<typeof allRejectedAsUnmatched>[0];

  it('全部 unmatched：品牌库里没有这个品牌，可对候选人说没合作', () => {
    expect(allRejectedAsUnmatched(planWith([{ input: '星巴克', reason: 'unmatched' }]))).toBe(true);
  });

  it('掺一个 ambiguous 就不能下"没合作"的结论', () => {
    expect(
      allRejectedAsUnmatched(
        planWith([
          { input: '星巴克', reason: 'unmatched' },
          { input: '刘姐', reason: 'ambiguous' },
        ]),
      ),
    ).toBe(false);
  });

  it('没有被拒品牌时为 false', () => {
    expect(allRejectedAsUnmatched(planWith([]))).toBe(false);
  });
});

describe('目录外品牌 ID（badcase 2026-10-16 trace batch_6ad1eb74ce406a6aeec80597_1792142350490：视觉把 10006 读成 100006）', () => {
  const catalogWithPizzaHut: BrandItem[] = [...catalog, { id: 10006, name: '必胜客', aliases: [] }];

  it('目录带 ID 时，目录外的 ID 进 rejected(unmatched_id)，不再用 String(id) 冒充品牌名', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [100006],
      sessionBrandState: null,
      catalog: catalogWithPizzaHut,
    });
    expect(plan.allRejected).toBe(true);
    expect(plan.applied).toEqual([]);
    expect(plan.queryBrandIdList).toEqual([]);
    expect(plan.rejected).toEqual([{ input: '100006', reason: 'unmatched_id' }]);
    expect(toBrandQueryMeta(plan).appliedCanonicalNames).toEqual([]);
  });

  it('目录内 ID 照常采信，与目录外 ID 混传时只拒目录外那一个', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [10006, 100006],
      sessionBrandState: null,
      catalog: catalogWithPizzaHut,
    });
    expect(plan.allRejected).toBe(false);
    expect(plan.queryBrandIdList).toEqual([10006]);
    expect(plan.applied).toEqual([{ canonicalName: '必胜客', brandId: 10006 }]);
    expect(plan.rejected).toEqual([{ input: '100006', reason: 'unmatched_id' }]);
  });

  it('旧响应目录整体缺 id 时无从校验，模型 ID 保持原样采信', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [100006],
      sessionBrandState: null,
      catalog: [{ name: '必胜客', aliases: [] }],
    });
    expect(plan.rejected).toEqual([]);
    expect(plan.queryBrandIdList).toEqual([100006]);
  });

  it('unmatched_id 不算"没合作"：allRejectedAsUnmatched 为 false', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [100006],
      sessionBrandState: null,
      catalog: catalogWithPizzaHut,
    });
    expect(allRejectedAsUnmatched(plan)).toBe(false);
    expect(rejectedBrandIds(plan)).toEqual(['100006']);
  });

  it('数字近邻只接受单字符插入/删除：100006→10006（多读一位）、1006→10006（少读一位）', () => {
    const more = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [100006],
      sessionBrandState: null,
      catalog: catalogWithPizzaHut,
    });
    expect(findRejectedIdNeighbors(more, catalogWithPizzaHut)).toEqual([
      { inputId: '100006', brandId: 10006, brandName: '必胜客', relation: 'delete_one_digit' },
    ]);
    const fewer = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [1006],
      sessionBrandState: null,
      catalog: catalogWithPizzaHut,
    });
    expect(findRejectedIdNeighbors(fewer, catalogWithPizzaHut).map((item) => item.brandId)).toEqual(
      [10006],
    );
    expect(findRejectedIdNeighbors(fewer, catalogWithPizzaHut)[0].relation).toBe(
      'insert_one_digit',
    );
  });

  it('替换类差异（10007 vs 10006/10008）不是近邻，猜不得', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [10007],
      sessionBrandState: null,
      catalog: catalogWithPizzaHut,
    });
    expect(findRejectedIdNeighbors(plan, catalogWithPizzaHut)).toEqual([]);
  });
});

describe('findUnprovenancedRejectedBrands（badcase 2026-10-13 trace batch_6acda349ce406a6aee8d6641_1791862156121：模型凭空传「星巴克」）', () => {
  const planFor = (brandAliasList: string[], brandIdList: number[] = []) =>
    buildBrandQueryPlan({ brandAliasList, brandIdList, catalog });

  it('候选人原话没出现过的目录外品牌名被判为无出处', () => {
    expect(
      findUnprovenancedRejectedBrands(planFor(['星巴克']), ['福贤路岭南天地店有岗吗']),
    ).toEqual([{ input: '星巴克', reason: 'unmatched' }]);
  });

  it('候选人原话或截图描述里出现过（含全半角/大小写差异）就有出处', () => {
    expect(findUnprovenancedRejectedBrands(planFor(['星巴克']), ['星巴克还招人吗'])).toEqual([]);
    expect(
      findUnprovenancedRejectedBrands(planFor(['Blue Bottle']), [
        '截图：ＢＬＵＥ ｂｏｔｔｌｅ 招聘',
      ]),
    ).toEqual([]);
  });

  it('出处材料不可用（null）时不新增拦截', () => {
    expect(findUnprovenancedRejectedBrands(planFor(['星巴克']), null)).toEqual([]);
  });

  it('目录外 ID 不走原话核对（ID 来自截图读数，另有数字近邻处置）', () => {
    const plan = buildBrandQueryPlan({
      brandAliasList: [],
      brandIdList: [100006],
      catalog: [...catalog, { id: 10006, name: '必胜客', aliases: [] }],
    });
    expect(findUnprovenancedRejectedBrands(plan, ['随便说点什么'])).toEqual([]);
  });

  it('歧义别名同样要有出处：候选人没说过的「小龙」不得进澄清话术', () => {
    expect(findUnprovenancedRejectedBrands(planFor(['小龙']), ['我在上海'])).toEqual([
      expect.objectContaining({ input: '小龙', reason: 'ambiguous' }),
    ]);
    expect(findUnprovenancedRejectedBrands(planFor(['小龙']), ['小龙有岗吗'])).toEqual([]);
  });
});
