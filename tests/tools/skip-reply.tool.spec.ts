import { buildSkipReplyTool, isShortConfirmationMessage } from '@tools/skip-reply.tool';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { ToolBuildContext } from '@shared-types/tool.types';
import { createToolContext, mergeToolContext } from '../helpers/tool-context.fixture';

describe('buildSkipReplyTool', () => {
  // 默认上下文：上轮 Agent 已推荐岗位，候选人本轮回「好的」——场景一两条运行时准入都满足。
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
    turnInput: {
      messages: [
        { role: 'user', content: '有什么岗位' },
        { role: 'assistant', content: '肯德基万达店在招服务员，时薪 22，你看合适吗' },
        { role: 'user', content: '好的' },
      ],
      currentUserMessage: '好的',
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

  // 2026-10-19 BadCase 复核 [05]（trace batch_6ad093aace406a6aeec4fee0_1792054200262）：候选人首句
  // 「我是星空」，模型 reason 自述「不符合 skip_reply 条件，应正常回复」仍以 confirmation_closure 调用，
  // 工具一接受即整轮静默，候选人等了 51 分钟。
  describe('confirmation_closure runtime admission', () => {
    it.each(['我是星空', '好的'])(
      'rejects an opening line without assistant history: %s',
      async (message) => {
        const ctx = mergeToolContext(mockContext, {
          turnInput: {
            messages: [{ role: 'user', content: message }],
            currentUserMessage: message,
          },
        });
        const result = await execute(buildTool(ctx), {
          scene: 'confirmation_closure',
          reason: '候选人首句，不符合 skip_reply 条件，应正常回复',
        });

        expect(result).toMatchObject({
          success: false,
          skipped: false,
          scene: 'confirmation_closure',
          errorType: TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NO_PRIOR_TURN,
        });
        expect(result).not.toHaveProperty('shortCircuited');
        expect(result._replyInstruction).toMatch(/首句|正常开场回复/);
      },
    );

    it('rejects a current message that carries a new question or request', async () => {
      const ctx = mergeToolContext(mockContext, {
        turnInput: { currentUserMessage: '你们公司有承包海底捞的招聘么\n好的' },
      });
      const result = await execute(buildTool(ctx), {
        scene: 'confirmation_closure',
        reason: '候选人回复好的',
      });

      expect(result).toMatchObject({
        skipped: false,
        errorType: TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK,
      });
      expect(result).not.toHaveProperty('shortCircuited');
      expect(result._replyInstruction).toMatch(/正常回复/);
    });

    it.each(['多久通知呀', '几天上班'])(
      'rejects short duration questions even without a question mark: %s',
      async (currentUserMessage) => {
        const ctx = mergeToolContext(mockContext, { turnInput: { currentUserMessage } });
        const result = await execute(buildTool(ctx), {
          scene: 'confirmation_closure',
          reason: '候选人确认',
        });
        expect(result).toMatchObject({
          skipped: false,
          errorType: TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK,
        });
        expect(result).not.toHaveProperty('shortCircuited');
      },
    );

    it('falls back to the trailing user block when currentUserMessage is absent', async () => {
      const ctx = mergeToolContext(mockContext, {
        turnInput: {
          messages: [
            { role: 'assistant', content: '肯德基万达店在招服务员' },
            { role: 'user', content: [{ type: 'text', text: '这个大概多久会通知呀' }] },
          ],
          currentUserMessage: undefined,
        },
      });
      const result = await execute(buildTool(ctx), {
        scene: 'confirmation_closure',
        reason: '候选人确认',
      });
      expect(result).toMatchObject({
        skipped: false,
        errorType: TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK,
      });
    });

    it('checks the complete trailing user block instead of only its final acknowledgement', async () => {
      const ctx = mergeToolContext(mockContext, {
        turnInput: {
          messages: [
            { role: 'assistant', content: '有问题随时联系' },
            { role: 'user', content: '明天几点到？' },
            { role: 'user', content: '好的' },
          ],
          currentUserMessage: undefined,
        },
      });
      const result = await execute(buildTool(ctx), {
        scene: 'confirmation_closure',
        reason: '候选人回复好的',
      });
      expect(result).toMatchObject({
        skipped: false,
        errorType: TOOL_ERROR_TYPES.SKIP_REPLY_CONFIRMATION_NOT_SHORT_ACK,
      });
      expect(result).not.toHaveProperty('shortCircuited');
    });

    it('accepts a short polite acknowledgement with stickers and punctuation', async () => {
      const ctx = mergeToolContext(mockContext, {
        turnInput: { currentUserMessage: '好的，谢谢您，非常感谢[抱拳][抱拳]' },
      });
      const result = await execute(buildTool(ctx), {
        scene: 'confirmation_closure',
        reason: '候选人礼貌收尾',
      });
      expect(result).toMatchObject({ skipped: true, shortCircuited: true });
    });

    it('human_takeover is not subject to the confirmation admission', async () => {
      const ctx = mergeToolContext(mockContext, {
        turnInput: {
          messages: [{ role: 'user', content: '我是星空' }],
          currentUserMessage: '我是星空，想问下岗位情况？',
          humanTakeoverActive: true,
        },
      });
      const result = await execute(buildTool(ctx), { scene: 'human_takeover', reason: '回应真人' });
      expect(result).toMatchObject({ skipped: true, shortCircuited: true });
    });
  });

  describe('isShortConfirmationMessage', () => {
    it('enforces fewer than 10 characters after removing punctuation and markers', () => {
      expect(isShortConfirmationMessage('好的，谢谢您非常感谢[抱拳]')).toBe(true);
      expect(isShortConfirmationMessage('好的，谢谢您真的很感谢[抱拳]')).toBe(false);
    });

    it('does not equate a short non-question with semantic acknowledgement', () => {
      expect(isShortConfirmationMessage('我是星空')).toBe(true);
      // 首句是否允许沉默由 messages 中的 assistant 历史单独校验。
    });

    it.each([
      '好的',
      '好呢，谢谢',
      '好的呢',
      '嗯嗯好滴\n[表情消息]',
      '好的，谢谢您，非常感谢',
      '好的👌谢谢你耐心讲解',
      '好的，多谢[抱拳][抱拳][抱拳]',
      'OK，收到',
      '[语音转文字，时长2秒] 嗯，好嘞，谢谢',
      '好的[消息发送时间: 2026-10-15 14:00]',
    ])('accepts short acknowledgement: %s', (text) => {
      expect(isShortConfirmationMessage(text)).toBe(true);
    });

    // 「我是星空」这类短自我介绍不含问句、不足 10 字，由「窗口无经理侧消息」准入拦，不在本判据内。
    it.each([
      '这个大概多久会通知呀',
      '你们公司有承包海底捞的招聘么\n好的',
      '我法定假日不上班\n有这样的兼职吗\n好的，谢谢',
      '好的，我先考虑下地点和薪资哈',
      '不用了，谢谢，临时兼职的一般都是周末或者节假日',
      '明天几点到店？',
      '是不是要带身份证',
      '',
      '[表情消息]',
    ])('rejects non-acknowledgement or question: %s', (text) => {
      expect(isShortConfirmationMessage(text)).toBe(false);
    });
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
