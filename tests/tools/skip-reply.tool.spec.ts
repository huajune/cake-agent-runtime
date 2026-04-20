import { buildSkipReplyTool } from '@tools/skip-reply.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildSkipReplyTool', () => {
  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    chatId: 'chat-1',
    messages: [],
    botUserId: 'mgr-bob',
    botImId: 'bot-im-1',
    contactName: 'Alice',
  };

  const buildTool = (ctx: ToolBuildContext = mockContext) => buildSkipReplyTool()(ctx);

  it('returns skipped=true with trimmed reason and instruction', async () => {
    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      reason: '  候选人回复好的，上轮已拉群  ',
    });

    expect(result).toMatchObject({
      skipped: true,
      reason: '候选人回复好的，上轮已拉群',
    });
    expect(typeof result.instruction).toBe('string');
    expect(result.instruction).toMatch(/不得|结束/);
  });

  it('works when chatId is missing (falls back to sessionId)', async () => {
    const tool = buildTool({ ...mockContext, chatId: undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({ reason: '候选人回复谢谢' });

    expect(result).toMatchObject({ skipped: true, reason: '候选人回复谢谢' });
  });

  it('rejects empty reason via Zod schema', async () => {
    const tool = buildTool();
    const schema = (tool as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } })
      .inputSchema;
    expect(schema.safeParse({ reason: '' }).success).toBe(false);
    expect(schema.safeParse({ reason: '候选人说好的' }).success).toBe(true);
  });
});
