import {
  isCollectionStalled,
  resolveCollectFieldAdoptions,
  summarizeCollectAskRounds,
} from '@tools/duliday/precheck/collect-circuit-breaker.util';

describe('collect_fields 断路器（议题 9-2）', () => {
  describe('resolveCollectFieldAdoptions — 出口 A：采纳模型已提交的答案', () => {
    it('adopts an answer whose key only differs by a modal prefix（黄燕案）', () => {
      const adoptions = resolveCollectFieldAdoptions(['需要中餐厅服务员经验'], {
        有无中餐厅服务员经验: '无',
      });

      expect(adoptions).toEqual([
        { field: '需要中餐厅服务员经验', value: '无', answerKey: '有无中餐厅服务员经验' },
      ]);
    });

    it('adopts an answer whose key only differs by a bracket annotation（王淼案同族）', () => {
      const adoptions = resolveCollectFieldAdoptions(['身高(cm)', '有无本地健康证'], {
        '身高（cm）': '153',
        是否有本地健康证: '有',
      });

      expect(adoptions.map((adoption) => adoption.field)).toEqual(['身高(cm)', '有无本地健康证']);
      expect(adoptions.map((adoption) => adoption.value)).toEqual(['153', '有']);
    });

    it('does not adopt an unrelated key or an empty value', () => {
      expect(
        resolveCollectFieldAdoptions(['需要中餐厅服务员经验'], { 有无西餐厅服务员经验: '有' }),
      ).toEqual([]);
      expect(
        resolveCollectFieldAdoptions(['需要中餐厅服务员经验'], { 需要中餐厅服务员经验: '   ' }),
      ).toEqual([]);
    });

    it('returns nothing when there is nothing missing or nothing submitted', () => {
      expect(resolveCollectFieldAdoptions([], { 身高: '153' })).toEqual([]);
      expect(resolveCollectFieldAdoptions(['身高'], undefined)).toEqual([]);
    });
  });

  describe('summarizeCollectAskRounds / isCollectionStalled — 出口 B：转人工', () => {
    const missing = ['身高', '体重'];

    it('counts每一次收资模板下发，并记录候选人此后是否回过话', () => {
      const rounds = summarizeCollectAskRounds(
        [
          { role: 'assistant', content: '面试要求：先将以下资料补充下发给我\n身高：\n体重：' },
          { role: 'user', content: '身高153 体重130' },
          { role: 'assistant', content: '还差身高和体重，麻烦补一下' },
          { role: 'user', content: '发过了呀' },
        ],
        missing,
      );

      expect(rounds).toEqual({ askCount: 2, userRepliedAfterLatestAsk: true });
      expect(isCollectionStalled(missing, rounds)).toBe(true);
    });

    it('does not escalate before the second ask', () => {
      const rounds = summarizeCollectAskRounds(
        [
          { role: 'assistant', content: '面试要求：先将以下资料补充下发给我\n身高：\n体重：' },
          { role: 'user', content: '好的' },
        ],
        missing,
      );

      expect(rounds.askCount).toBe(1);
      expect(isCollectionStalled(missing, rounds)).toBe(false);
    });

    it('does not escalate while the candidate has not answered the latest ask', () => {
      const rounds = summarizeCollectAskRounds(
        [
          { role: 'assistant', content: '身高、体重麻烦补一下' },
          { role: 'user', content: '好' },
          { role: 'assistant', content: '身高、体重还差着呢' },
        ],
        missing,
      );

      expect(rounds).toEqual({ askCount: 2, userRepliedAfterLatestAsk: false });
      expect(isCollectionStalled(missing, rounds)).toBe(false);
    });

    it('never escalates when nothing is missing anymore', () => {
      expect(isCollectionStalled([], { askCount: 5, userRepliedAfterLatestAsk: true })).toBe(false);
    });
  });
});
