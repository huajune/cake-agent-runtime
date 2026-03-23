import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';

/**
 * 自定义 OpenRouter Provider
 *
 * 基于官方 @openrouter/ai-sdk-provider（原生支持 AI SDK ProviderV3）。
 * 为 Kimi K2 模型注入自定义 fetch，修复流式 tool_calls.type 为空字符串的 bug。
 */

function createKimiK2Fetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);

    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      return response;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const transformedStream = new ReadableStream({
      async start(controller) {
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            if (buffer) controller.enqueue(encoder.encode(buffer));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);

              if (jsonStr.trim() === '[DONE]' || !jsonStr.trim()) {
                controller.enqueue(encoder.encode(line + '\n'));
                continue;
              }

              try {
                const data = JSON.parse(jsonStr);

                if (data.choices?.[0]?.delta?.tool_calls) {
                  data.choices[0].delta.tool_calls = data.choices[0].delta.tool_calls.map(
                    (tc: Record<string, unknown>) =>
                      tc.type === '' ? { ...tc, type: 'function' } : tc,
                  );
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n`));
                } else {
                  controller.enqueue(encoder.encode(line + '\n'));
                }
              } catch {
                controller.enqueue(encoder.encode(line + '\n'));
              }
            } else {
              controller.enqueue(encoder.encode(line + '\n'));
            }
          }
        }
      },
    });

    return new Response(transformedStream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

export function createCustomOpenRouter(config: {
  apiKey: string;
  baseURL?: string;
}): OpenRouterProvider {
  const baseConfig = {
    apiKey: config.apiKey,
    baseURL: config.baseURL || 'https://openrouter.ai/api/v1',
  };

  const defaultProvider = createOpenRouter(baseConfig);

  return new Proxy(defaultProvider, {
    get(target, prop: string | symbol): unknown {
      if (prop === 'languageModel' || prop === 'chat' || prop === 'completion') {
        return (modelId: string) => {
          const customFetch = modelId.includes('kimi-k2') ? createKimiK2Fetch() : undefined;

          const provider = createOpenRouter({
            ...baseConfig,
            fetch: customFetch,
          });

          if (prop === 'chat') return provider.chat(modelId);
          if (prop === 'completion') return provider.completion(modelId);
          return provider.languageModel(modelId);
        };
      }

      return target[prop as keyof OpenRouterProvider];
    },
  }) as OpenRouterProvider;
}
