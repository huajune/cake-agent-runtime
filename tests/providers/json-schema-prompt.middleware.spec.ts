import type { LanguageModelMiddleware } from 'ai';
import { jsonSchemaInPromptMiddleware } from '@providers/json-schema-prompt.middleware';

type TransformInput = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0];
type CallParams = TransformInput['params'];

const schema = {
  type: 'object',
  properties: { excludeTags: { type: 'array', description: '候选人明确说不做的班次' } },
};

function transform(params: Partial<CallParams>) {
  return jsonSchemaInPromptMiddleware.transformParams!({
    type: 'generate',
    params: { prompt: [], ...params } as CallParams,
    model: {} as TransformInput['model'],
  });
}

describe('jsonSchemaInPromptMiddleware', () => {
  it('把 schema 写进系统消息并改走 JSON 模式，字段说明随之对模型可见', async () => {
    const result = await transform({
      prompt: [
        { role: 'system', content: '你是求职偏好提取引擎。' },
        { role: 'user', content: [{ type: 'text', text: '下午5点以后有空，但是不上夜班' }] },
      ],
      responseFormat: { type: 'json', schema: schema as never, name: 'Prefs' },
    });

    expect(result.responseFormat).toEqual({ type: 'json' });
    expect(result.prompt.map((message) => message.role)).toEqual(['system', 'system', 'user']);
    expect(result.prompt[1]).toEqual({
      role: 'system',
      content: `Return JSON that conforms to the following schema: ${JSON.stringify(schema)}`,
    });
    expect(String(result.prompt[1].content)).toContain('候选人明确说不做的班次');
  });

  it('没有系统消息时 schema 说明放在最前', async () => {
    const result = await transform({
      prompt: [{ role: 'user', content: [{ type: 'text', text: '请描述这张图片' }] }],
      responseFormat: { type: 'json', schema: schema as never },
    });

    expect(result.prompt.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it.each([
    ['普通文本生成', {}],
    ['不带 schema 的 JSON 模式', { responseFormat: { type: 'json' as const } }],
  ])('%s原样放行', async (_name, extra) => {
    const params = {
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: '你好' }] }],
      ...extra,
    };

    expect(await transform(params)).toEqual({ ...params });
  });
});
