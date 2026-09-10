import { generateText, jsonSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { snapshotToolDefinitions } from '@/llm/tool-definition-snapshot';

describe('snapshotToolDefinitions', () => {
  it('matches the schema and description sent by the SDK, including nested field descriptions', async () => {
    const execute = jest.fn();
    const tools = {
      geocode: {
        description: '解析地址的实际工具说明',
        inputSchema: z.object({
          address: z.string().describe('地址字段说明'),
          location: z.object({ city: z.string().describe('城市字段说明') }).optional(),
        }),
        execute,
        providerOptions: { internal: { apiKey: 'must-not-be-snapshotted' } },
      },
    };
    const snapshots = await snapshotToolDefinitions(tools, {
      toolsContext: { geocode: { token: 'runtime-context-must-not-be-snapshotted' } },
    });
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    });
    await generateText({ model, prompt: 'hello', tools, maxRetries: 0 });

    expect(model.doGenerateCalls[0].tools?.[0]).toMatchObject(snapshots[0]);
    expect(JSON.stringify(snapshots)).toContain('地址字段说明');
    expect(JSON.stringify(snapshots)).toContain('城市字段说明');
    expect(JSON.stringify(snapshots)).not.toContain('must-not-be-snapshotted');
    expect(snapshots[0]).not.toHaveProperty('execute');
    expect(execute).not.toHaveBeenCalled();
  });

  it('awaits lazy async JSON schema and freezes it as plain JSON', async () => {
    const schema = { type: 'object' as const, description: '异步字段说明' };
    const snapshots = await snapshotToolDefinitions({
      lookup: { inputSchema: jsonSchema(async () => schema) },
    });
    schema.description = 'later mutation';
    expect(snapshots[0].inputSchema).toEqual({ type: 'object', description: '异步字段说明' });
  });

  it('marks an unavailable schema without losing other definitions or recording raw errors', async () => {
    const snapshots = await snapshotToolDefinitions({
      broken: {
        description: '仍可保留说明',
        inputSchema: jsonSchema(async () => {
          throw new Error('secret-token');
        }),
      },
      healthy: { inputSchema: z.object({ value: z.string() }) },
    });
    expect(snapshots[0]).toEqual({
      name: 'broken',
      type: 'function',
      description: '仍可保留说明',
      unavailableFields: ['inputSchema'],
    });
    expect(snapshots[1].inputSchema).toBeDefined();
    expect(JSON.stringify(snapshots)).not.toContain('secret-token');
  });
});
