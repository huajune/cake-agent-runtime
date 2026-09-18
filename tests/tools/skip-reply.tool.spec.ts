import { buildSkipReplyTool } from '@tools/skip-reply.tool';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext, mergeToolContext } from '../helpers/tool-context.fixture';

describe('buildSkipReplyTool', () => {
  const mockContext: ToolBuildContext = createToolContext({
    session: {
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: 'sess-1',
      chatId: 'chat-1',
      botUserId: 'mgr-bob',
      botImId: 'bot-im-1',
      contactName: 'Alice',
    },
  });

  const buildTool = (ctx: ToolBuildContext = mockContext) => buildSkipReplyTool()(ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execute = (tool: unknown, input: unknown) => (tool as any).execute(input);

  it('confirmation_closure returns skipped=true + shortCircuited=true with trimmed reason', async () => {
    const result = await execute(buildTool(), {
      scene: 'confirmation_closure',
      reason: '  候选人回复好的，上轮已拉群  ',
    });

    expect(result).toMatchObject({
      skipped: true,
      shortCircuited: true,
      scene: 'confirmation_closure',
      reason: '候选人回复好的，上轮已拉群',
    });
    expect(typeof result.instruction).toBe('string');
    expect(result.instruction).toMatch(/不得|结束/);
  });

  it('human_takeover is accepted only when the latest manager-side message is human-sent', async () => {
    const ctx = mergeToolContext(mockContext, { turnInput: { humanTakeoverActive: true } });
    const result = await execute(buildTool(ctx), {
      scene: 'human_takeover',
      reason: '候选人回复"有的"，回应真人经理问话',
    });

    expect(result).toMatchObject({ skipped: true, shortCircuited: true, scene: 'human_takeover' });
  });

  // 生产 chat 6a4dbf4bce406a6aee3137e4（2026-09-17）：真人只在 36 分钟前发过开场"你好"，之后
  // 14 条经理侧消息全是 Agent 发的；候选人问"前厅还是后厨"，模型编造"真人发了前厅"并静默。
  it('human_takeover is rejected (no short-circuit) when the latest manager-side message is Agent-sent', async () => {
    const ctx = mergeToolContext(mockContext, { turnInput: { humanTakeoverActive: false } });
    const result = await execute(buildTool(ctx), {
      scene: 'human_takeover',
      reason: '候选人回应真人经理手动发送的消息"前厅"，没有新诉求',
    });

    expect(result).toMatchObject({
      success: false,
      skipped: false,
      scene: 'human_takeover',
      errorType: TOOL_ERROR_TYPES.SKIP_REPLY_HUMAN_TAKEOVER_NOT_ACTIVE,
    });
    expect(result).not.toHaveProperty('shortCircuited');
    expect(result._replyInstruction).toMatch(/正常回复/);
  });

  it('human_takeover is rejected when the flag is absent (defaults to not active)', async () => {
    const result = await execute(buildTool(), { scene: 'human_takeover', reason: '回应真人' });
    expect(result).toMatchObject({ skipped: false });
  });

  it('works when chatId is missing (falls back to sessionId)', async () => {
    const tool = buildTool(mergeToolContext(mockContext, { session: { chatId: undefined } }));
    const result = await execute(tool, { scene: 'confirmation_closure', reason: '候选人回复谢谢' });

    expect(result).toMatchObject({ skipped: true, reason: '候选人回复谢谢' });
  });

  it('rejects empty reason and unknown/missing scene via Zod schema', async () => {
    const tool = buildTool();
    const schema = (
      tool as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    ).inputSchema;
    expect(schema.safeParse({ scene: 'confirmation_closure', reason: '' }).success).toBe(false);
    expect(schema.safeParse({ reason: '候选人说好的' }).success).toBe(false);
    expect(schema.safeParse({ scene: 'other', reason: '候选人说好的' }).success).toBe(false);
    expect(schema.safeParse({ scene: 'human_takeover', reason: '候选人说好的' }).success).toBe(
      true,
    );
  });
});
