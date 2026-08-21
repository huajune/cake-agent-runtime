import { detectExampleValueLeak } from '@agent/guardrail/output/rules/example-value-leak.rule';
import { HardRulesService } from '@agent/guardrail/output/hard-rules.service';
import { OUTPUT_RULE_CATALOG } from '@agent/guardrail/output/rules/output-rule-catalog';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

describe('example_value_leak', () => {
  const productionShapedText = (reply: string): string =>
    [
      '[引用 候选人：我把资料发你了]',
      '[图片消息]',
      '候选人连续消息一：想问下门店。',
      '候选人连续消息二：也想确认电话。',
      reply,
      '[消息发送时间：2026-08-13 10:24:31]',
    ].join('\n');

  it('observes a registered canary without vetoing the reply', () => {
    const hit = detectExampleValueLeak(
      productionShapedText('可以去测试门店了解，电话 13800138000。'),
    );

    expect(hit).toEqual(
      expect.objectContaining({
        ruleId: 'example_value_leak',
        action: GUARDRAIL_ACTION.OBSERVE,
      }),
    );
    expect(hit?.label).toContain('测试门店');
    expect(hit?.label).toContain('13800138000');
  });

  it('does not match ordinary production-shaped content', () => {
    expect(
      detectExampleValueLeak(productionShapedText('我先按本轮岗位结果帮你核对门店和联系方式。')),
    ).toBeNull();
  });

  it('is registered in the output catalog at observe action', () => {
    expect(OUTPUT_RULE_CATALOG.find((entry) => entry.id === 'example_value_leak')).toEqual(
      expect.objectContaining({ action: GUARDRAIL_ACTION.OBSERVE }),
    );
  });

  it('is dispatched by HardRulesService as a sendable observe verdict for runner archival', () => {
    const service = new HardRulesService({ sendAlert: jest.fn().mockResolvedValue(true) } as never);
    const result = service.check({
      replyText: productionShapedText('测试娟，我再帮你核对一下。'),
      toolCalls: [],
      chatId: 'chat-production-shape',
      traceId: 'trace-example-canary',
    });

    expect(result.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'example_value_leak',
          action: GUARDRAIL_ACTION.OBSERVE,
          currentReplySendable: true,
        }),
      ]),
    );
  });
});
