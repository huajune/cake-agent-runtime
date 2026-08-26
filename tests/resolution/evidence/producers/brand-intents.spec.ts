import type { BrandItem } from '@/sponge/sponge.types';
import {
  produceBrandAliasHints,
  produceValidatedBrandIntents,
} from '@resolution/evidence/producers/brand-intents';

const catalog: BrandItem[] = [
  { id: 10001, name: '肯德基', aliases: ['KFC'] },
  { id: 10003, name: '瑞幸咖啡', aliases: ['瑞幸', 'luckin'] },
  { id: 10008, name: '小龙坎', aliases: ['小龙'] },
  { id: 10009, name: '小龙翻大江', aliases: ['小龙'] },
];

describe('produceBrandAliasHints（hints 轨的协议标记清洗在 producer 内）', () => {
  it('returns catalog-confirmed hints from user text', () => {
    expect(produceBrandAliasHints(['我想去肯德基'], catalog)).toEqual([
      { brandName: '肯德基', matchedAlias: '肯德基', sourceText: '我想去肯德基' },
    ]);
  });

  it('strips the 消息发送时间 suffix before matching（整句锚定识别器曾被该后缀击穿）', () => {
    const hints = produceBrandAliasHints(
      ['我想去肯德基\n[消息发送时间：2026-08-13 14:30]'],
      catalog,
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].brandName).toBe('肯德基');
    expect(hints[0].sourceText).not.toContain('消息发送时间');
  });

  it('strips quoted blocks（引用里的经理话术不是候选人意向）', () => {
    expect(produceBrandAliasHints(['[引用 招募经理：肯德基还招人吗]'], catalog)).toEqual([]);
  });

  it('drops ambiguous alias hits（同别名两家品牌不猜）', () => {
    expect(produceBrandAliasHints(['小龙'], catalog)).toEqual([]);
  });

  it('dedupes the same brand within one message', () => {
    expect(produceBrandAliasHints(['肯德基和KFC都行'], catalog)).toHaveLength(1);
  });

  it('returns nothing without messages or catalog', () => {
    expect(produceBrandAliasHints([], catalog)).toEqual([]);
    expect(produceBrandAliasHints(['肯德基'], [])).toEqual([]);
  });
});

describe('produceValidatedBrandIntents（LLM 意图的目录确权与说话人归因）', () => {
  it('accepts a catalog-confirmed positive intent and carries the polarity', () => {
    const { accepted, rejected } = produceValidatedBrandIntents(
      [{ brand: '瑞幸', polarity: 'positive' }],
      catalog,
    );
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      canonicalName: '瑞幸咖啡',
      intentPolarity: 'positive',
    });
  });

  it('accepts brandless negative / browse_all intents（"都看看"没有品牌名也成立）', () => {
    const { accepted } = produceValidatedBrandIntents(
      [
        { brand: null, polarity: 'browse_all' },
        { brand: '  ', polarity: 'negative' },
      ],
      catalog,
    );
    expect(accepted.map((item) => item.intentPolarity)).toEqual(['browse_all', 'negative']);
    expect(accepted.every((item) => item.canonicalName === null)).toBe(true);
  });

  it('rejects a brandless positive intent（没品牌名的"想去"不成立）', () => {
    const { accepted, rejected } = produceValidatedBrandIntents(
      [{ brand: null, polarity: 'positive' }],
      catalog,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ brand: null, reason: 'empty_positive' }]);
  });

  it('rejects catalog misses instead of inventing a brand', () => {
    const { accepted, rejected } = produceValidatedBrandIntents(
      [{ brand: '不存在的品牌', polarity: 'positive' }],
      catalog,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ brand: '不存在的品牌', reason: 'catalog_miss' }]);
  });

  it('rejects an assistant echo（弱模型把 Agent 的整句找店话术当候选人意向）', () => {
    const utterance = '我看下有家肯德基离你大概9公里';
    const { accepted, rejected } = produceValidatedBrandIntents(
      [{ brand: utterance, polarity: 'positive' }],
      catalog,
      [utterance],
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ brand: utterance, reason: 'assistant_echo' }]);
  });

  // 回声门只拦整句形态：Agent 提过的品牌被候选人裸名复述（指代链接）仍是真实意向。
  it('keeps a bare brand name even when the assistant just mentioned it', () => {
    const { accepted, rejected } = produceValidatedBrandIntents(
      [{ brand: '肯德基', polarity: 'positive' }],
      catalog,
      ['这边有肯德基的岗位，要看看吗'],
    );
    expect(rejected).toEqual([]);
    expect(accepted[0]).toMatchObject({ canonicalName: '肯德基', intentPolarity: 'positive' });
  });

  it('rejects guardrail/system text reflow（守卫反馈被当候选人原话会形成自我强化回路）', () => {
    const reflow = '- [brand_alias_fuzzy_match_ignored] 问题：工具品牌回指为：肯德基';
    const { accepted, rejected } = produceValidatedBrandIntents(
      [{ brand: reflow, polarity: 'positive' }],
      catalog,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ brand: reflow, reason: 'system_text_reflow' }]);
  });
});
