import { createOpenAI } from '@ai-sdk/openai';

/**
 * 自定义 OpenAI Provider
 *
 * 解决第三方代理服务不支持 /v1/responses 端点的问题。
 *
 * AI SDK v5 默认使用新的 /v1/responses 端点，
 * 代理服务器（如 ohmygpt）只支持 /v1/chat/completions，
 * 因此拦截 languageModel 调用，强制使用 chat 方法。
 */
export function createCustomOpenAI(config: { apiKey: string; baseURL?: string }) {
  const openaiInstance = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  return new Proxy(openaiInstance, {
    get(_target, prop) {
      if (prop === 'languageModel') {
        return (modelId: string) => openaiInstance.chat(modelId);
      }

      if (prop === 'chat' || prop === 'completion') {
        return openaiInstance[prop as keyof typeof openaiInstance];
      }

      if (prop === 'embeddingModel' || prop === 'imageModel') {
        const method = openaiInstance[prop as keyof typeof openaiInstance];
        return method || undefined;
      }

      return openaiInstance[prop as keyof typeof openaiInstance];
    },
  });
}
