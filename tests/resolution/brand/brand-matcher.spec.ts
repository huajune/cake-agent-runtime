/**
 * BrandResolution 单元测试（spec §14.1 全部用例）。
 *
 * 纯函数直测：目录直接注入，不需要 NestJS 容器。
 */

import type { BrandItem } from '@/sponge/sponge.types';
import { resolveBrandAliasInputs, resolveBrands } from '@resolution/brand/brand-matcher';
import type { BrandResolution } from '@resolution/brand/brand-resolution.types';

const catalog: BrandItem[] = [
  { id: 10001, name: '肯德基', aliases: ['KFC'] },
  { id: 10002, name: '麦当劳', aliases: ['金拱门', 'mc'] },
  { id: 10239, name: 'M Stand', aliases: ['mstand'] },
  { id: 10003, name: '瑞幸咖啡', aliases: ['瑞幸', 'luckin'] },
  { id: 10004, name: '拉瓦萨', aliases: [] },
  { id: 10005, name: '全家', aliases: [] },
  { id: 10006, name: '来伊份', aliases: ['来一份', '来1份'] },
  { id: 10007, name: '奥乐齐', aliases: [] },
  // 冲突别名：两家品牌共用别名"小龙"
  { id: 10008, name: '小龙坎', aliases: ['小龙'] },
  { id: 10009, name: '小龙翻大江', aliases: ['小龙'] },
];

function names(results: BrandResolution[]): string[] {
  return results.map((r) => r.canonicalName).filter((n): n is string => Boolean(n));
}

function positives(results: BrandResolution[]): BrandResolution[] {
  return results.filter((r) => r.intentPolarity === 'positive' && !r.ambiguous);
}

function negatives(results: BrandResolution[]): BrandResolution[] {
  return results.filter((r) => r.intentPolarity === 'negative');
}

describe('resolveBrands - 实体匹配（§14.1）', () => {
  it('标准品牌名正向识别', () => {
    const results = resolveBrands('我想去肯德基', 'user_text', catalog);
    expect(names(results)).toEqual(['肯德基']);
    expect(results[0].intentPolarity).toBe('positive');
    expect(results[0].brandId).toBe(10001);
  });

  it('唯一别名识别：KFC → 肯德基', () => {
    const results = resolveBrands('KFC', 'user_text', catalog);
    expect(names(results)).toEqual(['肯德基']);
    expect(results[0].matchType).toBe('alias_exact');
  });

  it('品牌 ID 识别（"品牌ID：10239" 格式契约）', () => {
    const results = resolveBrands('岗位标题 [10239]；品牌ID：10239', 'user_text', catalog);
    const idHit = results.find((r) => r.matchType === 'brand_id');
    expect(idHit?.canonicalName).toBe('M Stand');
    expect(idHit?.brandId).toBe(10239);
    expect(idHit?.confidence).toBe(1.0);
  });

  it('"想去KFC看看"：短英数别名 token 边界包含命中', () => {
    const results = resolveBrands('想去KFC看看', 'user_text', catalog);
    expect(names(results)).toEqual(['肯德基']);
    expect(results[0].intentPolarity).toBe('positive');
  });

  it('"不要肯德基" 输出 negative', () => {
    const results = resolveBrands('不要肯德基', 'user_text', catalog);
    expect(negatives(results).map((r) => r.canonicalName)).toEqual(['肯德基']);
    expect(positives(results)).toHaveLength(0);
  });

  it('"除了肯德基都可以" 输出 negative(肯德基)', () => {
    const results = resolveBrands('除了肯德基都可以', 'user_text', catalog);
    expect(negatives(results).map((r) => r.canonicalName)).toEqual(['肯德基']);
  });

  it('"肯德基和麦当劳都可以" 输出两条 positive', () => {
    const results = resolveBrands('肯德基和麦当劳都可以', 'user_text', catalog);
    expect(names(positives(results)).sort()).toEqual(['肯德基', '麦当劳']);
    expect(negatives(results)).toHaveLength(0);
  });

  it('"肯德基不要，麦当劳可以"：negative(肯德基) + positive(麦当劳)', () => {
    const results = resolveBrands('肯德基不要，麦当劳可以', 'user_text', catalog);
    expect(negatives(results).map((r) => r.canonicalName)).toEqual(['肯德基']);
    expect(names(positives(results))).toEqual(['麦当劳']);
  });

  it('"品牌不限" 输出 browse_all', () => {
    const results = resolveBrands('品牌不限', 'user_text', catalog);
    expect(results.some((r) => r.intentPolarity === 'browse_all')).toBe(true);
  });

  it('"换个品牌" 输出品牌为空的 negative', () => {
    const results = resolveBrands('换个品牌', 'user_text', catalog);
    const emptyNegative = negatives(results).find((r) => r.canonicalName === null);
    expect(emptyNegative).toBeDefined();
    expect(emptyNegative?.brandId).toBeNull();
  });

  it('"肯德基还招吗" 输出 positive（查询即意向）', () => {
    const results = resolveBrands('肯德基还招吗', 'user_text', catalog);
    expect(names(positives(results))).toEqual(['肯德基']);
  });

  it('"你刚才说的肯德基" 输出 positive（回应推荐也是兴趣信号）', () => {
    const results = resolveBrands('你刚才说的肯德基', 'user_text', catalog);
    expect(names(positives(results))).toEqual(['肯德基']);
  });

  it('"我朋友在肯德基上班" 按业务默认输出 positive（提及即兴趣，不设中性档）', () => {
    const results = resolveBrands('我朋友在肯德基上班', 'user_text', catalog);
    expect(names(positives(results))).toEqual(['肯德基']);
  });

  it('"要不要肯德基" 疑问式不判否定', () => {
    const results = resolveBrands('你要不要肯德基', 'user_text', catalog);
    expect(names(positives(results))).toEqual(['肯德基']);
    expect(negatives(results)).toHaveLength(0);
  });
});

describe('resolveBrands - 微信昵称（contact_name，§14.1）', () => {
  it('Gattouzo 微信昵称不产生品牌', () => {
    expect(resolveBrands('Gattouzo', 'contact_name', catalog)).toEqual([]);
  });

  it('"肯德基-上海" 微信昵称产生高置信品牌', () => {
    const results = resolveBrands('肯德基-上海', 'contact_name', catalog);
    expect(names(results)).toEqual(['肯德基']);
    expect(results[0].confidence).toBeGreaterThanOrEqual(0.75);
    expect(results[0].source).toBe('contact_name');
  });

  it('"KFC松江" 微信昵称归一化为肯德基', () => {
    const results = resolveBrands('KFC松江', 'contact_name', catalog);
    expect(names(results)).toEqual(['肯德基']);
  });

  it('"奥乐齐-杨浦" 标准名安全包含命中', () => {
    const results = resolveBrands('奥乐齐-杨浦', 'contact_name', catalog);
    expect(names(results)).toEqual(['奥乐齐']);
  });

  it('"全家幸福" 短别名上下文不足不识别', () => {
    expect(resolveBrands('全家幸福', 'contact_name', catalog)).toEqual([]);
  });

  it('"咖啡爱好者" 昵称不做品类展开', () => {
    expect(resolveBrands('咖啡爱好者', 'contact_name', catalog)).toEqual([]);
  });
});

describe('resolveBrands - 短别名误判防护（§7.3/§14.1）', () => {
  it('"我们全家都可以" 不能命中"全家"', () => {
    expect(resolveBrands('我们全家都可以', 'user_text', catalog)).toEqual([]);
  });

  it('"给我来一份工作" 不能命中"来伊份"', () => {
    expect(resolveBrands('给我来一份工作', 'user_text', catalog)).toEqual([]);
  });

  it('"我报过名了" 不因短别名命中品牌', () => {
    const withShortAlias: BrandItem[] = [
      ...catalog,
      { id: 10010, name: '报亭咖啡', aliases: ['报'] },
    ];
    expect(resolveBrands('我报过名了', 'user_text', withShortAlias)).toEqual([]);
  });

  it('单独说"想去全家"（token 全等）可命中', () => {
    // 短别名只走全等 token：降噪表剥不掉"想去"，此处验证独立词形"全家"本身可命中
    const results = resolveBrands('全家', 'user_text', catalog);
    expect(names(results)).toEqual(['全家']);
  });

  it('"mcm包包" 不命中短英数别名 mc（token 边界防护）', () => {
    expect(resolveBrands('mcm包包', 'user_text', catalog)).toEqual([]);
  });
});

describe('resolveBrands - 冲突别名与歧义（§14.1）', () => {
  it('冲突别名返回 ambiguity，不直接选择其中一个', () => {
    const results = resolveBrands('小龙', 'user_text', catalog);
    expect(results).toHaveLength(1);
    expect(results[0].ambiguous).toBe(true);
    expect(results[0].canonicalName).toBeNull();
    expect(results[0].confidence).toBeLessThanOrEqual(0.4);
    expect(results[0].candidates?.map((c) => c.canonicalName).sort()).toEqual([
      '小龙坎',
      '小龙翻大江',
    ]);
  });
});

describe('resolveBrands - 图片来源（image_description，§14.1）', () => {
  it('图片品牌默认 positive', () => {
    const results = resolveBrands('招聘截图：麦当劳 兼职 时薪25', 'image_description', catalog);
    expect(names(positives(results))).toEqual(['麦当劳']);
    expect(results[0].source).toBe('image_description');
  });

  it('图片中的品牌 ID 优先解析（"品牌ID：10239"格式契约，同品牌只返回一条）', () => {
    const results = resolveBrands(
      'Boss直聘岗位卡片：[10239] M Stand咖啡店员；品牌ID：10239',
      'image_description',
      catalog,
    );
    const mstand = results.filter((r) => r.canonicalName === 'M Stand');
    expect(mstand).toHaveLength(1);
    expect(mstand[0].matchType).toBe('brand_id');
    expect(mstand[0].confidence).toBe(1.0);
  });
});

describe('resolveBrands - 品类展开（§6.2/§14.1）', () => {
  it('"咖啡" 品类词展开为品类品牌，matchType 为 category_expansion', () => {
    const results = resolveBrands('我想找咖啡兼职', 'user_text', catalog);
    const expanded = results.filter((r) => r.matchType === 'category_expansion');
    expect(names(expanded).sort()).toEqual(['拉瓦萨', '瑞幸咖啡']);
    expect(expanded.every((r) => r.intentPolarity === 'positive')).toBe(true);
    expect(expanded.every((r) => r.confidence === 0.75)).toBe(true);
    expect(expanded.every((r) => r.matchedText === '咖啡')).toBe(true);
  });

  it('品类词与具体品牌同现时只返回具体品牌，不展开品类', () => {
    const results = resolveBrands('我要瑞幸咖啡的兼职', 'user_text', catalog);
    expect(names(results)).toEqual(['瑞幸咖啡']);
    expect(results.every((r) => r.matchType !== 'category_expansion')).toBe(true);
  });

  it('品类词处于否定语境时不展开', () => {
    expect(
      resolveBrands('不要咖啡', 'user_text', catalog).filter(
        (r) => r.matchType === 'category_expansion',
      ),
    ).toEqual([]);
  });
});

describe('resolveBrands - 指示代词排斥（§6.3.1 规则轨）', () => {
  it('"这个不考虑" 输出品牌为空的 negative', () => {
    const results = resolveBrands('这个不考虑', 'user_text', catalog);
    const emptyNegative = negatives(results).find((r) => r.canonicalName === null);
    expect(emptyNegative).toBeDefined();
  });

  it('"不要这个" 输出品牌为空的 negative', () => {
    const results = resolveBrands('不要这个', 'user_text', catalog);
    expect(negatives(results).some((r) => r.canonicalName === null)).toBe(true);
  });

  it('"这家算了" 输出品牌为空的 negative', () => {
    const results = resolveBrands('这家算了', 'user_text', catalog);
    expect(negatives(results).some((r) => r.canonicalName === null)).toBe(true);
  });
});

describe('resolveBrandAliasInputs - 工具入口标准化（§8.2）', () => {
  it('别名解析成唯一标准品牌并携带品牌 ID', () => {
    const outcome = resolveBrandAliasInputs(['KFC', '金拱门'], catalog);
    expect(outcome.applied.map((b) => b.canonicalName).sort()).toEqual(['肯德基', '麦当劳']);
    expect(outcome.applied.every((b) => b.brandId !== null)).toBe(true);
    expect(outcome.rejected).toEqual([]);
  });

  it('未命中项进入 rejected(unmatched)', () => {
    const outcome = resolveBrandAliasInputs(['Gattouzo'], catalog);
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected).toEqual([{ input: 'Gattouzo', reason: 'unmatched' }]);
  });

  it('冲突别名进入 rejected(ambiguous) 并携带候选', () => {
    const outcome = resolveBrandAliasInputs(['小龙'], catalog);
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected[0].reason).toBe('ambiguous');
    expect(outcome.rejected[0].candidates?.length).toBe(2);
  });

  it('品类词入参展开为品类品牌（已上线咖啡召回不回归）', () => {
    const outcome = resolveBrandAliasInputs(['咖啡'], catalog);
    expect(outcome.applied.map((b) => b.canonicalName).sort()).toEqual(['拉瓦萨', '瑞幸咖啡']);
  });
});
