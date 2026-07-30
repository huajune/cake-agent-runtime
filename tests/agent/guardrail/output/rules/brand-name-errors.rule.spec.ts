import type { AgentToolCall } from '@agent/generator/generator.types';
import { detectRequestedBrandMismatch } from '@agent/guardrail/output/rules/brand-name-errors.rule';

/** 构造一次 duliday_job_list 调用，queryMeta.brand 声明工具实际应用了哪些品牌。 */
function jobListCall(appliedCanonicalNames: string[]): AgentToolCall {
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

describe('detectRequestedBrandMismatch', () => {
  it('工具应用品牌与回复品牌一致时不判违规', () => {
    expect(
      detectRequestedBrandMismatch(structuredRecommendation('成都你六姐'), [
        jobListCall(['成都你六姐']),
      ]),
    ).toBeNull();
  });

  it('回复推荐了工具没应用的其它品牌时判 requested_brand_mismatch', () => {
    const hit = detectRequestedBrandMismatch(structuredRecommendation('必胜客'), [
      jobListCall(['成都你六姐']),
    ]);
    expect(hit?.ruleId).toBe('requested_brand_mismatch');
  });

  describe('数字写法差异不算品牌串台（2026-07-29 日报实证假阳）', () => {
    it('工具事实用汉字数词、回复写阿拉伯数字时视为同一品牌', () => {
      expect(
        detectRequestedBrandMismatch(structuredRecommendation('成都你6姐'), [
          jobListCall(['成都你六姐']),
        ]),
      ).toBeNull();
    });

    it('反向同样成立：工具事实写数字、回复写汉字', () => {
      expect(
        detectRequestedBrandMismatch(structuredRecommendation('一点点'), [jobListCall(['1点点'])]),
      ).toBeNull();
    });

    it('折叠只放宽数字写法，不会把不同品牌并档', () => {
      // 夹具说明：品牌名不能带连字符——extractStructuredJobTitleBrands 的捕获组
      // 显式排除 - 与 —，"7-11便利店"这类根本不会被提取成品牌，测不到对账逻辑。
      const hit = detectRequestedBrandMismatch(structuredRecommendation('85度C'), [
        jobListCall(['成都你六姐']),
      ]);
      expect(hit?.ruleId).toBe('requested_brand_mismatch');
    });
  });
});
