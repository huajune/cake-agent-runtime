import {
  detectRepeatedReply,
  pruneRepeatedReplySegments,
} from '@agent/guardrail/output/rules/repeated-reply.rule';

describe('repeated reply deterministic segment pruning', () => {
  const delivered = [
    '这家目前暂时排不上，我再帮你看看其他门店',
    '你可以把方便上班的区域发我，我按区域继续找',
  ];

  it('按投递同款分段只删全等旧段，保留本轮新增信息', () => {
    const result = pruneRepeatedReplySegments(
      '这家目前暂时排不上，我再帮你看看其他门店。\n\n[引用 候选人：那徐汇呢]\n徐汇区还有一家门店，我继续帮你核实\n[消息发送时间：2026-08-13 10:24:32]',
      delivered,
      '[图片消息]\n那徐汇呢\n[消息发送时间：2026-08-13 10:24:31]',
    );

    expect(result.droppedSegments).toEqual(['这家目前暂时排不上，我再帮你看看其他门店']);
    expect(result.text).toContain('徐汇区还有一家门店');
    expect(result.text).not.toContain('这家目前暂时排不上');
  });

  it('候选人明确要求重发时不删除', () => {
    const text = '你可以把方便上班的区域发我，我按区域继续找。';
    expect(pruneRepeatedReplySegments(text, delivered, '刚才没看到，重新发我')).toEqual({
      text,
      droppedSegments: [],
    });
  });

  it('近似重复阈值只 observe，不触发 repair', () => {
    const hit = detectRepeatedReply(
      '你可以把方便上班的区域发我，我按区域继续找哦',
      delivered,
    );
    expect(hit?.action).toBe('observe');
  });
});
