import type { AgentToolCall } from '@agent/generator/generator.types';
import {
  detectBrandAliasFuzzyMatchIgnored,
  detectRequestedBrandMismatch,
} from '@agent/guardrail/output/rules/brand-name-errors.rule';

function jobListCall(suggestions: Array<{ brandName: string; score: number }>): AgentToolCall {
  return {
    toolName: 'duliday_job_list',
    result: { queryMeta: { brand: { fuzzySuggestions: suggestions } } },
  } as unknown as AgentToolCall;
}

describe('detectBrandAliasFuzzyMatchIgnored', () => {
  it('高置信目录回指已给出，回复却仍声称品牌未找到时命中', () => {
    const hit = detectBrandAliasFuzzyMatchIgnored('暂时没找到这个品牌的在招岗位', [
      jobListCall([{ brandName: '成都你六姐', score: 0.91 }]),
    ]);
    expect(hit?.ruleId).toBe('brand_alias_fuzzy_match_ignored');
  });

  it('回复按高置信回指继续查询时放行', () => {
    expect(
      detectBrandAliasFuzzyMatchIgnored('你说的应该是成都你六姐，我按这个品牌继续帮你看', [
        jobListCall([{ brandName: '成都你六姐', score: 0.91 }]),
      ]),
    ).toBeNull();
  });

  it('多个相近候选为低置信时不强行采用', () => {
    expect(
      detectBrandAliasFuzzyMatchIgnored('暂时没找到这个品牌的岗位', [
        jobListCall([
          { brandName: '成都你六姐', score: 0.91 },
          { brandName: '六姐姐', score: 0.82 },
        ]),
      ]),
    ).toBeNull();
  });

  it('没有岗位工具回执时不做开放品牌文本抽取', () => {
    expect(detectBrandAliasFuzzyMatchIgnored('暂时没找到这个品牌的岗位', [])).toBeNull();
  });
});

/** 构造一次 duliday_job_list 调用，queryMeta.brand 声明工具实际应用了哪些品牌。 */
function appliedBrandCall(appliedCanonicalNames: string[]): AgentToolCall {
  return {
    toolName: 'duliday_job_list',
    result: {
      queryMeta: {
        brand: {
          filterMode: 'enforce',
          appliedCanonicalNames,
        },
      },
    },
  } as unknown as AgentToolCall;
}

/** 结构化推荐标题：品牌（门店） - 岗位信息，命中 extractStructuredJobTitleBrands 第一条模式。 */
function structuredRecommendation(brandTitle: string): string {
  return `${brandTitle}（万象城店） - 服务员，18-40岁`;
}

// 2026-08-26 数据复核恢复：observe 哨兵，用例取自恢复前原判例，保持口径连续。
describe('detectRequestedBrandMismatch', () => {
  it('工具应用品牌与回复品牌一致时不判违规', () => {
    expect(
      detectRequestedBrandMismatch(structuredRecommendation('成都你六姐'), [
        appliedBrandCall(['成都你六姐']),
      ]),
    ).toBeNull();
  });

  it('回复推荐了工具没应用的其它品牌时判 requested_brand_mismatch', () => {
    const hit = detectRequestedBrandMismatch(structuredRecommendation('必胜客'), [
      appliedBrandCall(['成都你六姐']),
    ]);
    expect(hit?.ruleId).toBe('requested_brand_mismatch');
  });

  describe('数字写法差异不算品牌串台（2026-07-29 日报实证假阳）', () => {
    it('工具事实用汉字数词、回复写阿拉伯数字时视为同一品牌', () => {
      expect(
        detectRequestedBrandMismatch(structuredRecommendation('成都你6姐'), [
          appliedBrandCall(['成都你六姐']),
        ]),
      ).toBeNull();
    });

    it('反向同样成立：工具事实写数字、回复写汉字', () => {
      expect(
        detectRequestedBrandMismatch(structuredRecommendation('一点点'), [
          appliedBrandCall(['1点点']),
        ]),
      ).toBeNull();
    });

    it('折叠只放宽数字写法，不会把不同品牌并档', () => {
      // 夹具说明：品牌名不能带连字符——extractStructuredJobTitleBrands 的捕获组
      // 显式排除 - 与 —，"7-11便利店"这类根本不会被提取成品牌，测不到对账逻辑。
      const hit = detectRequestedBrandMismatch(structuredRecommendation('85度C'), [
        appliedBrandCall(['成都你六姐']),
      ]);
      expect(hit?.ruleId).toBe('requested_brand_mismatch');
    });
  });
});
