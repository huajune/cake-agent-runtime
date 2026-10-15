import type { LanguageModelMiddleware } from 'ai';

/**
 * 结构化输出改走 JSON 模式：把 schema（含字段说明）作为系统消息写进提示词，并从 responseFormat
 * 里去掉 schema，厂商随之按普通 JSON 模式生成、不做约束解码。输出仍由 AI SDK 按原 schema 校验，
 * 不合 schema 走既有的重试与降级。写法与 @ai-sdk/deepseek 的兼容模式一致。
 */
export const jsonSchemaInPromptMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const format = params.responseFormat;
    if (format?.type !== 'json' || format.schema == null) return params;

    const leadingSystem = params.prompt.findIndex((message) => message.role !== 'system');
    const insertAt = leadingSystem === -1 ? params.prompt.length : leadingSystem;
    return {
      ...params,
      prompt: [
        ...params.prompt.slice(0, insertAt),
        {
          role: 'system',
          content: `Return JSON that conforms to the following schema: ${JSON.stringify(format.schema)}`,
        },
        ...params.prompt.slice(insertAt),
      ],
      responseFormat: { type: 'json' },
    };
  },
};
