/**
 * SessionBrandState reducer 单元测试（spec §14.2 会话测试的纯函数部分）。
 */

import type { BrandItem } from '@/sponge/sponge.types';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import {
  brandStateChanged,
  initBrandState,
  reduceBrandState,
  shouldDropLateResolutions,
} from '@resolution/brand/brand-state.reducer';
import type { BrandResolution, SessionBrandState } from '@resolution/brand/brand-resolution.types';

const catalog: BrandItem[] = [
  { id: 1, name: '肯德基', aliases: ['KFC'] },
  { id: 2, name: '麦当劳', aliases: ['金拱门'] },
  { id: 3, name: '瑞幸咖啡', aliases: ['瑞幸'] },
  { id: 4, name: '拉瓦萨', aliases: [] },
  { id: 5, name: 'M Stand', aliases: ['mstand'] },
];

function makeResolution(overrides: Partial<BrandResolution>): BrandResolution {
  return {
    canonicalName: null,
    brandId: null,
    matchedText: null,
    sourceText: null,
    source: 'user_text',
    matchType: 'canonical_exact',
    intentPolarity: 'positive',
    confidence: 0.95,
    ambiguous: false,
    ...overrides,
  };
}

const positive = (name: string, source: BrandResolution['source'] = 'user_text') =>
  makeResolution({ canonicalName: name, matchedText: name, source });
const negative = (name: string | null, source: BrandResolution['source'] = 'user_text') =>
  makeResolution({
    canonicalName: name,
    matchedText: name,
    source,
    intentPolarity: 'negative',
    matchType: name ? 'canonical_exact' : null,
  });
const browseAll = () =>
  makeResolution({ intentPolarity: 'browse_all', matchType: null, confidence: 0.95 });

const EMPTY: SessionBrandState = { currentBrand: null, excludedBrands: [] };

describe('reduceBrandState（§9.3 四步）', () => {
  it('新品牌替换当前主品牌', () => {
    const prev: SessionBrandState = {
      currentBrand: { canonicalName: '肯德基', brandId: 1 },
      excludedBrands: [],
    };
    const next = reduceBrandState(prev, [positive('麦当劳')]);
    expect(next.currentBrand?.canonicalName).toBe('麦当劳');
    expect(next.excludedBrands).toEqual([]);
  });

  it('排斥品牌不进入正向品牌', () => {
    const next = reduceBrandState(EMPTY, [negative('肯德基')]);
    expect(next.currentBrand).toBeNull();
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('排斥过的品牌在后续轮次被正向表达 → 移出 excluded、成为 current（反悔即赦免）', () => {
    const prev: SessionBrandState = {
      currentBrand: null,
      excludedBrands: [{ canonicalName: '肯德基', brandId: 1 }],
    };
    const next = reduceBrandState(prev, [positive('肯德基')]);
    expect(next.currentBrand?.canonicalName).toBe('肯德基');
    expect(next.excludedBrands).toEqual([]);
  });

  it('"换个品牌"（品牌为空 negative）把当前主品牌移入排斥并清空', () => {
    const prev: SessionBrandState = {
      currentBrand: { canonicalName: '肯德基', brandId: 1 },
      excludedBrands: [],
    };
    const next = reduceBrandState(prev, [negative(null)]);
    expect(next.currentBrand).toBeNull();
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('品牌为空 negative 在无 currentBrand 时什么都不做', () => {
    const next = reduceBrandState(EMPTY, [negative(null)]);
    expect(next).toEqual(EMPTY);
  });

  it('不限品牌（browse_all）清空当前和排斥品牌', () => {
    const prev: SessionBrandState = {
      currentBrand: { canonicalName: '肯德基', brandId: 1 },
      excludedBrands: [{ canonicalName: '麦当劳', brandId: 2 }],
    };
    const next = reduceBrandState(prev, [browseAll()]);
    expect(next.currentBrand).toBeNull();
    expect(next.excludedBrands).toEqual([]);
  });

  it('seed 后昵称品牌与普通品牌同权：新品牌替换、排斥进 excluded', () => {
    const seeded = initBrandState({
      nicknameSeed: { canonicalName: '肯德基', brandId: 1 },
    });
    expect(seeded.currentBrand?.canonicalName).toBe('肯德基');

    const replaced = reduceBrandState(seeded, [positive('麦当劳')]);
    expect(replaced.currentBrand?.canonicalName).toBe('麦当劳');

    const excluded = reduceBrandState(seeded, [negative('肯德基')]);
    expect(excluded.currentBrand).toBeNull();
    expect(excluded.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('contact_name 来源的结果被过滤，不参与常规轮次状态更新', () => {
    const prev: SessionBrandState = {
      currentBrand: { canonicalName: '麦当劳', brandId: 2 },
      excludedBrands: [],
    };
    const next = reduceBrandState(prev, [positive('肯德基', 'contact_name')]);
    expect(next.currentBrand?.canonicalName).toBe('麦当劳');
  });

  it('图片品牌可以更新当前主品牌', () => {
    const next = reduceBrandState(EMPTY, [positive('M Stand', 'image_description')]);
    expect(next.currentBrand?.canonicalName).toBe('M Stand');
  });

  it('同轮"肯德基不要，麦当劳可以"与倒序输入产生相同状态（批量应用顺序无关）', () => {
    const forward = reduceBrandState(EMPTY, [negative('肯德基'), positive('麦当劳')]);
    const backward = reduceBrandState(EMPTY, [positive('麦当劳'), negative('肯德基')]);
    expect(forward).toEqual(backward);
    expect(forward.currentBrand?.canonicalName).toBe('麦当劳');
    expect(forward.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('同一品牌同轮又要又不要时，排斥赢', () => {
    const next = reduceBrandState(EMPTY, [positive('肯德基'), negative('肯德基')]);
    expect(next.currentBrand).toBeNull();
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('同轮图片 positive(A) + 文字 positive(B) → current=B（文字优先于图片）', () => {
    const next = reduceBrandState(EMPTY, [
      positive('麦当劳', 'user_text'),
      positive('M Stand', 'image_description'),
    ]);
    expect(next.currentBrand?.canonicalName).toBe('麦当劳');
  });

  it('多品牌正向表达不写 currentBrand；其中品牌在 excludedBrands 中则照常移除', () => {
    const prev: SessionBrandState = {
      currentBrand: null,
      excludedBrands: [{ canonicalName: '肯德基', brandId: 1 }],
    };
    const next = reduceBrandState(prev, [positive('肯德基'), positive('麦当劳')]);
    expect(next.currentBrand).toBeNull();
    expect(next.excludedBrands).toEqual([]);
  });

  it('debounce 合并的两条单品牌消息（2 条 positive）判为多品牌表达，currentBrand 不动', () => {
    const prev: SessionBrandState = {
      currentBrand: { canonicalName: '瑞幸咖啡', brandId: 3 },
      excludedBrands: [],
    };
    const next = reduceBrandState(prev, [positive('肯德基'), positive('麦当劳')]);
    expect(next.currentBrand?.canonicalName).toBe('瑞幸咖啡');
  });

  it('同来源同品牌的重复结果（规则轨 + LLM 轨）去重后仍是单品牌表达', () => {
    const next = reduceBrandState(EMPTY, [positive('肯德基'), positive('肯德基')]);
    expect(next.currentBrand?.canonicalName).toBe('肯德基');
  });

  it('咖啡品类展开不立主品牌，也不解除既有排斥', () => {
    // 2026-07-20 起品类词一律走多品牌展开（撤除 defaultBrand），按 §6.2 只做当轮查询
    // 扩展、不写会话主品牌——这同时堵死了"品类词改写 currentBrand"的状态污染通道。
    const prev: SessionBrandState = {
      currentBrand: null,
      excludedBrands: [{ canonicalName: '瑞幸咖啡', brandId: 3 }],
    };
    for (const text of ['我想找咖啡兼职', '其他咖啡品牌有吗']) {
      const resolutions = resolveBrands(text, 'user_text', catalog);
      expect(resolutions.every((r) => r.matchType === 'category_expansion')).toBe(true);

      const next = reduceBrandState(prev, resolutions);
      expect(next.currentBrand).toBeNull();
      expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['瑞幸咖啡']);
    }
  });

  it('同轮图片 positive(A) + 指示代词排斥（"这个不考虑"）→ 终态 excluded=[A]（纯规则轨）', () => {
    const imageResolutions = resolveBrands(
      '招聘海报：M Stand 咖啡师；品牌ID：5',
      'image_description',
      catalog,
    );
    const textResolutions = resolveBrands('这个不考虑', 'user_text', catalog);
    const next = reduceBrandState(EMPTY, [...imageResolutions, ...textResolutions]);
    expect(next.currentBrand).toBeNull();
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['M Stand']);
  });

  it('同轮多张不同品牌截图 → image 来源 ≥2 条 positive，判多品牌表达，currentBrand 不动', () => {
    const next = reduceBrandState(EMPTY, [
      positive('肯德基', 'image_description'),
      positive('麦当劳', 'image_description'),
    ]);
    expect(next.currentBrand).toBeNull();
  });

  it('歧义与低置信结果不参与状态更新', () => {
    const ambiguous = makeResolution({
      ambiguous: true,
      confidence: 0.4,
      candidates: [
        { canonicalName: '肯德基', brandId: 1 },
        { canonicalName: '麦当劳', brandId: 2 },
      ],
    });
    expect(reduceBrandState(EMPTY, [ambiguous])).toEqual(EMPTY);
  });
});

describe('initBrandState（§9.4；懒迁移档已于 2026-07-22 退役，§19.6）', () => {
  it('已验证昵称品牌 seed 进入初始状态', () => {
    const state = initBrandState({ nicknameSeed: { canonicalName: '肯德基', brandId: 1 } });
    expect(state.currentBrand?.canonicalName).toBe('肯德基');
    expect(state.excludedBrands).toEqual([]);
  });

  it('无昵称 seed 则空状态', () => {
    expect(initBrandState({})).toEqual(EMPTY);
  });
});

describe('shouldDropLateResolutions（§10.3 过期即弃）', () => {
  it('补写轮次早于状态最后变更时间 → 丢弃（排斥不被赦免）', () => {
    expect(
      shouldDropLateResolutions(
        { currentBrand: null, excludedBrands: [], updatedAtMs: 2000 },
        1000,
      ),
    ).toBe(true);
  });

  it('状态自补写轮次后未变更 → 应用', () => {
    expect(
      shouldDropLateResolutions(
        { currentBrand: null, excludedBrands: [], updatedAtMs: 1000 },
        2000,
      ),
    ).toBe(false);
  });
});

describe('brandStateChanged', () => {
  it('current 与 excluded 均未变时为 false', () => {
    const state: SessionBrandState = {
      currentBrand: { canonicalName: '肯德基', brandId: 1 },
      excludedBrands: [{ canonicalName: '麦当劳', brandId: 2 }],
    };
    expect(brandStateChanged(state, { ...state, excludedBrands: [...state.excludedBrands] })).toBe(
      false,
    );
    expect(brandStateChanged(state, { ...state, currentBrand: null })).toBe(true);
  });
});

describe('reduceBrandState - 同轮又要又不要不误清在位品牌（2026-07-21 生产审计）', () => {
  const incumbent: SessionBrandState = {
    currentBrand: { canonicalName: '成都你六姐', brandId: 6 },
    excludedBrands: [],
  };

  it('净否定品牌不上位：肯德基同轮正+负，被排斥且在位六姐保持', () => {
    // 生产形态："我43岁，肯德基年龄不行"——LLM 轨出 positive、规则轨出 negative。
    // 修复前 positive 先把肯德基顶上 currentBrand（六姐无辜出局），negative 再排斥
    // → 最终 currentBrand=null；修复后净否定品牌不参与替换。
    const next = reduceBrandState(incumbent, [positive('肯德基'), negative('肯德基')]);
    expect(next.currentBrand?.canonicalName).toBe('成都你六姐');
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('跨来源同样生效：图片轨 positive + 文字轨 negative', () => {
    const next = reduceBrandState(incumbent, [
      positive('肯德基', 'image_description'),
      negative('肯德基'),
    ]);
    expect(next.currentBrand?.canonicalName).toBe('成都你六姐');
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('净否定不拖累其他品牌上位："肯德基不行，麦当劳呢"', () => {
    const next = reduceBrandState(incumbent, [
      positive('肯德基'),
      negative('肯德基'),
      positive('麦当劳'),
    ]);
    expect(next.currentBrand?.canonicalName).toBe('麦当劳');
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['肯德基']);
  });

  it('在位品牌自身被否定仍照常清空（原行为不回归）', () => {
    const next = reduceBrandState(incumbent, [positive('成都你六姐'), negative('成都你六姐')]);
    expect(next.currentBrand).toBeNull();
    expect(next.excludedBrands.map((b) => b.canonicalName)).toEqual(['成都你六姐']);
  });
});
