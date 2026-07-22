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
  { id: 10207, name: '鄂尔多斯1980', aliases: ['鄂尔多斯'] },
  { id: 10311, name: 'Zara Home', aliases: ['zh'] },
  { id: 10319, name: 'Liquid Laundry', aliases: ['LL'] },
  { id: 10320, name: '成都你六姐', aliases: ['成都六姐'] },
  // 2026-07-21 生产误判复现用：渠道缩写撞车 + 4 字符拉丁别名昵称撞车
  { id: 10321, name: 'BAKER&SPICE', aliases: ['BS'] },
  { id: 10322, name: 'BIIIING缤水', aliases: ['Bing'] },
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

  it('"成都六姐不要人嘛" 是招聘状态问句，不判为排除品牌', () => {
    const results = resolveBrands('额，成都六姐不要人嘛', 'user_text', catalog);
    expect(names(positives(results))).toEqual(['成都你六姐']);
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

  it('"我是zh" 是短昵称自我介绍，不命中 Zara Home', () => {
    expect(resolveBrands('我是zh', 'user_text', catalog)).toEqual([]);
  });

  it('群来源说明末尾的 LL 是昵称，不命中 Liquid Laundry', () => {
    expect(resolveBrands('我是群聊“独立客&上海餐饮兼职12群”的LL', 'user_text', catalog)).toEqual(
      [],
    );
  });

  it('带消息时间戳后缀的群来源说明同样不命中（2026-07-15 生产假阳性原文）', () => {
    expect(
      resolveBrands(
        '我是群聊“独立客&上海餐饮兼职12群”的LL\n[消息发送时间：2026-07-15 16:13 星期三]',
        'user_text',
        catalog,
      ),
    ).toEqual([]);
  });

  it('纯短英文微信昵称 zh 不作为品牌 seed', () => {
    expect(resolveBrands('zh', 'contact_name', catalog)).toEqual([]);
  });

  it('地址中的鄂尔多斯路不命中鄂尔多斯1980', () => {
    expect(
      resolveBrands(
        '[位置分享] 宝山区乾皓苑（鄂尔多斯路东100米）（宝山区鄂尔多斯路）',
        'user_text',
        catalog,
      ),
    ).toEqual([]);
  });

  it('明确品牌表达仍能命中鄂尔多斯1980', () => {
    expect(names(resolveBrands('想找鄂尔多斯的岗位', 'user_text', catalog))).toEqual([
      '鄂尔多斯1980',
    ]);
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
  it('"咖啡兼职" 展开为完整咖啡品牌集合，不收敛到默认品牌', () => {
    // 2026-07-20 产品裁定：撤除 v10.15.0 的 defaultBrand（"咖啡"只出 M Stand）。
    const results = resolveBrands('我想找咖啡兼职', 'user_text', catalog);
    expect(names(results).sort()).toEqual(['M Stand', '拉瓦萨', '瑞幸咖啡']);
    expect(results[0]).toMatchObject({
      matchType: 'category_expansion',
      intentPolarity: 'positive',
      confidence: 0.75,
      matchedText: '咖啡',
    });
  });

  it('"其他咖啡品牌" 扩张为完整咖啡品牌集合', () => {
    const results = resolveBrands('其他咖啡品牌有吗', 'user_text', catalog);
    const expanded = results.filter((r) => r.matchType === 'category_expansion');
    expect(names(expanded).sort()).toEqual(['M Stand', '拉瓦萨', '瑞幸咖啡']);
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

  it('工种称谓“咖啡师”不触发品类通道（生产回归：报名途中改写 currentBrand）', () => {
    // 生产实例 6a5dbfa7（2026-07-20）：候选人已选定拉瓦萨，填报名表时写下
    // “应聘岗位：长期晚班咖啡师”，裸子串匹配把“咖啡”读成品类词，
    // currentBrand 被当时的 category_default 档从拉瓦萨改写成 M Stand。
    const form = '姓名：陈某 面试时间：周二 应聘门店：复旦管院店 应聘岗位：长期晚班咖啡师';
    expect(resolveBrands(form, 'user_text', catalog)).toEqual([]);

    for (const text of ['我面试咖啡师', '咖啡师', '接受无咖啡师经验', '想做咖啡学徒']) {
      expect(resolveBrands(text, 'user_text', catalog)).toEqual([]);
    }
  });

  it('工种词与品类词同现时仍按品类命中', () => {
    const results = resolveBrands('做咖啡师也行，主要想找咖啡店', 'user_text', catalog);
    expect(names(results).sort()).toEqual(['M Stand', '拉瓦萨', '瑞幸咖啡']);
    expect(results[0].matchType).toBe('category_expansion');
  });

  it('裸自我介绍“我是zara”不识别品牌，但求职句仍识别', () => {
    const zaraCatalog: BrandItem[] = [{ id: 20001, name: 'ZARA', aliases: ['zara'] }];
    expect(resolveBrands('我是zara', 'user_text', zaraCatalog)).toEqual([]);
    expect(resolveBrands("I'm Zara", 'user_text', zaraCatalog)).toEqual([]);
    expect(names(resolveBrands('zara导购还招人吗', 'user_text', zaraCatalog))).toEqual(['ZARA']);
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

  it('咖啡品类词入参展开为全部咖啡品牌', () => {
    const outcome = resolveBrandAliasInputs(['咖啡'], catalog);
    expect(outcome.applied.map((b) => b.canonicalName).sort()).toEqual([
      'M Stand',
      '拉瓦萨',
      '瑞幸咖啡',
    ]);
  });
});

describe('resolveBrands - 误命中归因字段（sourceText/matchedText）', () => {
  // 2026-07-21 观测期发现：事件里只有 matchType + canonicalName 时，脏别名塌缩与
  // 候选人真实简称长得一模一样，日检必须回查 chat_messages 才能分真假阳性。
  it('包含匹配同时留下命中词条与用户原文', () => {
    const results = positives(resolveBrands('我看附近好多成都六姐', 'user_text', catalog));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      canonicalName: '成都你六姐',
      matchType: 'alias_containment',
      matchedText: '成都六姐', // 命中的品牌库词条
      sourceText: '我看附近好多成都六姐', // 用户原文，归因靠它
    });
  });

  it('matchedText 记词条、sourceText 记原文，两者不是同一个东西', () => {
    const [result] = positives(resolveBrands('KFC松江那家还招人吗', 'user_text', catalog));
    expect(result.matchedText).toBe('KFC');
    expect(result.sourceText).toBe('KFC松江那家还招人吗');
  });

  it('品类展开也带原文，便于核对护栏是否该拦', () => {
    const [result] = resolveBrands('我想找咖啡兼职', 'user_text', catalog);
    expect(result).toMatchObject({ matchedText: '咖啡', sourceText: '我想找咖啡兼职' });
  });

  it('超长子句截断，不把整段消息灌进事件表', () => {
    // 子句内不能有分句符，否则 splitClauses 会先切短，测不到截断
    const longClause = `${'我想找一份稳定的工作'.repeat(12)}KFC`;
    const [result] = positives(resolveBrands(longClause, 'user_text', catalog));
    expect(result.sourceText).toHaveLength(81); // 80 字符 + 省略号
    expect(result.sourceText!.endsWith('…')).toBe(true);
  });
});

describe('resolveBrands - 渠道缩写与昵称自介误命中（2026-07-21 生产审计）', () => {
  it('"我是BS上加的" 指 Boss直聘 渠道，不命中 BAKER&SPICE（黑名单降级为仅全等）', () => {
    expect(resolveBrands('我是BS上加的', 'user_text', catalog)).toEqual([]);
  });

  it('单独打 "BS" 仍可全等命中 BAKER&SPICE（黑名单只降档不封杀）', () => {
    const results = positives(resolveBrands('BS', 'user_text', catalog));
    expect(names(results)).toEqual(['BAKER&SPICE']);
  });

  it('"我是🥚冠Bing" 是加好友昵称自介，不命中 BIIIING缤水', () => {
    // 归一化剥掉 emoji 后余部 "冠bing" 呈昵称形态；≥4 字符拉丁别名的无边界包含
    // 此前无自介守卫（2-3 字符守卫覆盖不到），生产实锤误 seed 品牌状态
    expect(resolveBrands('我是🥚冠Bing', 'user_text', catalog)).toEqual([]);
  });

  it('"我是Bing" 裸自介同样不命中', () => {
    expect(resolveBrands('我是Bing', 'user_text', catalog)).toEqual([]);
  });

  it('带求职语境的自介开头照常识别："我是想问luckin还招吗"', () => {
    const results = positives(resolveBrands('我是想问luckin还招吗', 'user_text', catalog));
    expect(names(results)).toEqual(['瑞幸咖啡']);
  });

  it('非自介句里的 4 字符拉丁别名照常包含命中："Bing有什么兼职"', () => {
    const results = positives(resolveBrands('Bing有什么兼职', 'user_text', catalog));
    expect(names(results)).toEqual(['BIIIING缤水']);
  });
});
