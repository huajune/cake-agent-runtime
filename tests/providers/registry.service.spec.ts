import { ConfigService } from '@nestjs/config';
import { stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { RegistryService } from '@providers/registry.service';
import { RouterService } from '@providers/router.service';
import { ReliableService } from '@providers/reliable.service';
import { ModelRole, ReplyModelRoute } from '@/llm/llm.types';
import { LlmExecutorService } from '@/llm/llm-executor.service';

function setup(env: Record<string, string>) {
  const config = new ConfigService(env);
  jest.spyOn(config, 'get').mockImplementation((key: string) => env[key]);
  const registry = new RegistryService(config);
  registry.onModuleInit();
  return {
    registry,
    executor: new LlmExecutorService(
      new RouterService(config),
      registry,
      new ReliableService(registry),
    ),
  };
}

describe('company model providers', () => {
  afterEach(() => jest.restoreAllMocks());

  it('exposes only Qwen and DeepSeek even with all retired credentials present', () => {
    const { registry } = setup({
      ANTHROPIC_API_KEY: 'old',
      GEMINI_API_KEY: 'old',
      OPENROUTER_API_KEY: 'old',
      GATEWAY_API_KEY: 'old',
      GATEWAY_BASE_URL: 'https://gateway.invalid',
      MOONSHOT_API_KEY: 'old',
      DASHSCOPE_API_KEY: 'q',
      DEEPSEEK_API_KEY: 'd',
    });
    expect(registry.listProviders().sort()).toEqual(['deepseek', 'qwen']);
    expect(new Set(registry.listModels().map((m) => m.provider))).toEqual(
      new Set(['qwen', 'deepseek']),
    );
    expect(registry.listModels().map((m) => m.id)).toContain('deepseek/deepseek-flash');
    expect(registry.listModels().map((m) => m.id)).not.toContain('deepseek/deepseek-v4-flash');
    for (const id of [
      'openai/gpt-5',
      'anthropic/claude-sonnet-5',
      'google/gemini',
      'moonshotai/kimi-k3',
      'gateway/qwen/qwen4-max',
      'openrouter/deepseek/deepseek-flash',
      'ohmygpt/model',
      'qwen/openrouter/model',
    ]) {
      expect(() => registry.resolve(id)).toThrow();
    }
  });

  it('requires the supported provider’s own key and resolves saved Flash aliases', () => {
    const { registry } = setup({ DEEPSEEK_API_KEY: 'd', ANTHROPIC_API_KEY: 'old' });
    expect(registry.listProviders()).toEqual(['deepseek']);
    expect(registry.hasProvider('qwen')).toBe(false);
    expect(() => registry.resolve('qwen/qwen4-max')).toThrow('未注册');
    expect(registry.resolve('deepseek/deepseek-v4-flash')).toMatchObject({
      modelId: 'deepseek-flash',
    });
    expect(setup({ MOONSHOT_API_KEY: 'old' }).registry.listModels()).toEqual([]);
  });

  it('gives Flash a new two-minute request after Qwen times out and isolates caller cancellation', async () => {
    const { executor } = setup({
      DASHSCOPE_API_KEY: 'q',
      DEEPSEEK_API_KEY: 'd',
      AGENT_CHAT_MODEL: 'qwen/qwen4-max',
    });
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const clock = jest.spyOn(Date, 'now');
    let now = Date.now();
    clock.mockImplementation(() => now);
    const models: string[] = [];
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model;
      models.push(model);
      if (model === 'qwen4-max') {
        now += 120_000;
        throw new DOMException('headers timed out', 'TimeoutError');
      }
      now += 119_000;
      expect(init.signal.aborted).toBe(false);
      return Response.json({
        id: 'fixture',
        created: 1,
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      });
    });
    const result = await executor.generate({
      replyModelRoute: new ReplyModelRoute(),
      prompt: 'hello',
    });
    expect(result.modelId).toBe('deepseek/deepseek-flash');
    expect(models).toEqual(['qwen4-max', 'deepseek-flash']);
    expect(timeout.mock.calls.filter(([duration]) => duration === 120_000)).toHaveLength(2);
    const signal = new AbortController();
    fetch.mockImplementationOnce(async () => {
      signal.abort(new Error('caller stopped'));
      throw signal.signal.reason;
    });
    await expect(
      executor.generate({
        replyModelRoute: new ReplyModelRoute(),
        prompt: 'cancel',
        abortSignal: signal.signal,
      }),
    ).rejects.toThrow('caller stopped');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('uses the actual SDKs to carry an image and completed tool output from Qwen to Flash on the first 503', async () => {
    const { executor } = setup({
      DASHSCOPE_API_KEY: 'q',
      DEEPSEEK_API_KEY: 'd',
      AGENT_CHAT_MODEL: 'qwen/qwen4-max',
      AGENT_DEFAULT_FALLBACKS: 'qwen/qwen3.7-plus,anthropic/claude-sonnet-5',
    });
    const execute = jest.fn(async () => 'fixture-42');
    const requests: Array<{
      model: string;
      messages: Array<Record<string, unknown>>;
      thinking?: unknown;
    }> = [];
    const signals: AbortSignal[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      signals.push(init.signal);
      if (requests.length === 2)
        return Response.json(
          { error: { message: 'unavailable', type: 'server_error' } },
          { status: 503 },
        );
      const first = requests.length === 1;
      const message = first
        ? {
            role: 'assistant',
            content: null,
            reasoning_content: 'private-qwen-reasoning',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
            ],
          }
        : { role: 'assistant', content: 'Fixture confirmed.' };
      return Response.json({
        id: 'fixture',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: first ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU/0AAAAASUVORK5CYII=';
    const replyModelRoute = new ReplyModelRoute();
    const result = await executor.generate({
      replyModelRoute,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Check the picture and the fixture.' },
            { type: 'image', image: Buffer.from(png, 'base64'), mediaType: 'image/png' },
          ],
        },
      ],
      tools: { lookup: tool({ inputSchema: z.object({}), execute }) },
      stopWhen: stepCountIs(4),
      thinking: { type: 'enabled', budgetTokens: 1024, effort: 'high' },
    });
    expect(requests.map((r) => r.model)).toEqual(['qwen4-max', 'qwen4-max', 'deepseek-flash']);
    expect(new Set(signals).size).toBe(3);
    expect(requests[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            {
              type: 'image_url',
              image_url: expect.objectContaining({ url: 'data:image/png;base64,' + png }),
            },
          ]),
        }),
        expect.objectContaining({
          role: 'assistant',
          tool_calls: expect.arrayContaining([expect.objectContaining({ id: 'call-1' })]),
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call-1',
          content: expect.stringContaining('fixture-42'),
        }),
      ]),
    );
    expect(JSON.stringify(requests[2].messages)).not.toContain('private-qwen-reasoning');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Fixture confirmed.');
    await executor.generate({
      replyModelRoute,
      role: ModelRole.Chat,
      prompt: 'Follow up',
      purpose: 'empty_text_recovery',
    });
    await executor.generate({ replyModelRoute, role: ModelRole.Repair, prompt: 'Repair' });
    await executor.generate({
      replyModelRoute: new ReplyModelRoute(),
      role: ModelRole.Chat,
      prompt: 'Another turn',
    });
    expect(requests.slice(3).map((r) => r.model)).toEqual([
      'deepseek-flash',
      'deepseek-flash',
      'qwen4-max',
    ]);
  });
});
