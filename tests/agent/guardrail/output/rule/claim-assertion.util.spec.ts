import {
  assertsClaim,
  splitClaimSentences,
  textAssertsClaim,
} from '@agent/guardrail/output/rules/claim-assertion.util';

/**
 * claim-assertion 是被 booking-claim-errors / false-promises / job-fact-value-mismatch
 * 三个 rule 共用的声称判定原语，此前只有经由具体 rule 的间接覆盖（2026-07-06 review）。
 * 这里直接锁定切句、否定小句豁免、疑问豁免的边界语义。
 */
describe('claim-assertion.util', () => {
  const SUCCESS_CLAIM = /约好|报名成功|登记好|已预约/;

  describe('splitClaimSentences', () => {
    it('按 。！；换行 切句，逗号不切句', () => {
      expect(splitClaimSentences('先别急。不用担心，已经帮你约好了！稍等')).toEqual([
        '先别急',
        '不用担心，已经帮你约好了',
        '稍等',
      ]);
    });

    it('？切句但保留在句尾（供疑问豁免识别）', () => {
      expect(splitClaimSentences('约好了吗？我看看')).toEqual(['约好了吗？', '我看看']);
    });
  });

  describe('否定豁免（小句粒度）', () => {
    it('否定与声称同小句 → 豁免（诚实的失败/拒绝话术）', () => {
      expect(textAssertsClaim('暂时没能报名成功', SUCCESS_CLAIM)).toBe(false);
      expect(textAssertsClaim('没法帮你约好这个时间', SUCCESS_CLAIM)).toBe(false);
    });

    it('前小句否定不洗白后小句的成功宣称（跨小句不豁免）', () => {
      expect(textAssertsClaim('不用担心，已经帮你报名成功了', SUCCESS_CLAIM)).toBe(true);
    });
  });

  describe('疑问豁免', () => {
    it('？/句尾吗 → 问句，不算声称', () => {
      expect(textAssertsClaim('是不是已经帮你约好了？', SUCCESS_CLAIM)).toBe(false);
      expect(textAssertsClaim('之前帮你约好的那个还去吗', SUCCESS_CLAIM)).toBe(false);
    });

    it('句尾呢的陈述句不豁免——"登记好了呢"是带语气词的成功宣称', () => {
      expect(textAssertsClaim('已经帮你登记好了呢', SUCCESS_CLAIM)).toBe(true);
      expect(textAssertsClaim('已经帮你约好明天的面试了呢~', SUCCESS_CLAIM)).toBe(true);
    });

    it('句尾呢 + 句内疑问词 → 问句豁免', () => {
      expect(textAssertsClaim('你想约好哪天呢', SUCCESS_CLAIM)).toBe(false);
      expect(textAssertsClaim('约好几点方便呢', SUCCESS_CLAIM)).toBe(false);
    });
  });

  describe('assertsClaim（单句）', () => {
    it('pattern 未命中 → false', () => {
      expect(assertsClaim('明天记得带身份证', SUCCESS_CLAIM)).toBe(false);
    });

    it('多句文本任一句构成声称即为 true', () => {
      expect(textAssertsClaim('先别急。已经帮你约好了', SUCCESS_CLAIM)).toBe(true);
    });
  });
});
