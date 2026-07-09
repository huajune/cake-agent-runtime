import { GeneratorAgent } from '@agent/generator/generator.agent';
import type { GeneratorRunResult } from '@agent/generator/generator.types';

/**
 * attachTurnEnd 闭包契约：deferTurnEnd 时暴露的 runTurnEnd 必须透传
 * includeAssistantText——false 表示回复未真实送达，只跑用户侧收尾，
 * 不把未送达文本投影成助手轮次（幽灵回复防护）。
 */
describe('GeneratorAgent attachTurnEnd (runTurnEnd contract)', () => {
  const makeService = (onTurnEnd: jest.Mock) => {
    const configService = { get: (_k: string, d?: string) => d } as never;
    const preparation = {} as never;
    const memoryService = { onTurnEnd } as never;
    const llm = {} as never;
    return new GeneratorAgent(configService, preparation, memoryService, llm);
  };

  const ctx = {
    corpId: 'c1',
    userId: 'u1',
    sessionId: 's1',
    botImId: 'bot-1',
    normalizedMessages: [],
    turnState: { candidatePool: undefined },
  };

  const attach = (service: GeneratorAgent, result: GeneratorRunResult) => {
    (
      service as unknown as {
        attachTurnEnd: (
          result: GeneratorRunResult,
          ctx: unknown,
          messageId: string | undefined,
          assistantText: string,
          deferTurnEnd: boolean | undefined,
        ) => void;
      }
    ).attachTurnEnd(result, ctx, 'm1', '给候选人的回复', true);
  };

  const makeResult = (): GeneratorRunResult => ({
    text: '给候选人的回复',
    steps: 1,
    agentSteps: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });

  it('default (delivered) projects assistant text into turn end', async () => {
    const onTurnEnd = jest.fn().mockResolvedValue(undefined);
    const service = makeService(onTurnEnd);
    const result = makeResult();
    attach(service, result);

    await result.runTurnEnd?.();

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd.mock.calls[0][1]).toBe('给候选人的回复');
  });

  it('includeAssistantText=false drops assistant text (undelivered reply)', async () => {
    const onTurnEnd = jest.fn().mockResolvedValue(undefined);
    const service = makeService(onTurnEnd);
    const result = makeResult();
    attach(service, result);

    await result.runTurnEnd?.({ includeAssistantText: false });

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd.mock.calls[0][1]).toBeUndefined();
  });

  it('runTurnEnd is consumed once — second call is a no-op', async () => {
    const onTurnEnd = jest.fn().mockResolvedValue(undefined);
    const service = makeService(onTurnEnd);
    const result = makeResult();
    attach(service, result);

    await result.runTurnEnd?.({ includeAssistantText: false });
    await result.runTurnEnd?.();

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
  });
});
