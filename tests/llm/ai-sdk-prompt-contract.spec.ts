import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

const mockGenerateResult = {
  content: [{ type: 'text' as const, text: 'ok' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
  warnings: [],
};

describe('AI SDK prompt contract', () => {
  it('accepts a system prompt with a non-empty prompt', async () => {
    const model = new MockLanguageModelV3({ doGenerate: mockGenerateResult });

    const result = await generateText({
      model,
      system: '复聊系统上下文',
      prompt: '请根据以上上下文生成本次复聊消息。',
      maxRetries: 0,
    });

    expect(result.text).toBe('ok');
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0].prompt.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
  });

  it('rejects empty messages before calling the provider', async () => {
    const model = new MockLanguageModelV3({ doGenerate: mockGenerateResult });

    await expect(
      generateText({
        model,
        system: '复聊系统上下文',
        messages: [],
        maxRetries: 0,
      }),
    ).rejects.toThrow('Invalid prompt: messages must not be empty');

    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
