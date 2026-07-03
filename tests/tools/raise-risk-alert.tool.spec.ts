import { buildRaiseRiskAlertTool } from '@tools/raise-risk-alert.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildRaiseRiskAlertTool', () => {
  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    chatId: 'chat-1',
    messages: [{ role: 'user', content: '你说啥呢' }],
    botUserId: 'mgr-bob',
    botImId: 'bot-im-1',
    contactName: 'Alice',
  };

  const buildTool = (ctx: ToolBuildContext = mockContext) => buildRaiseRiskAlertTool()(ctx);

  it('returns missing_chat_id when chatId and sessionId are both absent', async () => {
    const tool = buildTool({ ...mockContext, chatId: undefined, sessionId: '' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'abuse',
      reason: '候选人骂人',
    });

    expect(result).toMatchObject({
      accepted: false,
      errorType: TOOL_ERROR_TYPES.MISSING_CHAT_ID,
    });
  });

  it('returns a conversation_risk sideEffect intent from the model semantic decision', async () => {
    const tool = buildTool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'escalation',
      reason: '候选人连续催促',
      summary: '情绪升级',
    });

    expect(result).toMatchObject({
      accepted: true,
      sideEffect: {
        kind: 'conversation_risk',
        source: 'agent_tool',
        riskType: 'escalation',
        riskLabel: '情绪升级',
        reason: '候选人连续催促',
        summary: '情绪升级',
        currentMessageContent: '你说啥呢',
      },
    });
    expect(result.sideEffect).not.toHaveProperty('recentMessages');
    expect(result.sideEffect).not.toHaveProperty('sessionState');
  });

  it('uses sessionId as chatId fallback without changing the sideEffect shape', async () => {
    const tool = buildTool({ ...mockContext, chatId: undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'complaint_risk',
      reason: '候选人威胁投诉',
    });

    expect(result).toMatchObject({
      accepted: true,
      sideEffect: {
        kind: 'conversation_risk',
        source: 'agent_tool',
        riskType: 'complaint_risk',
      },
    });
  });

  it('keeps the latest user message from the current model-visible context', async () => {
    const tool = buildTool({
      ...mockContext,
      messages: [
        { role: 'user', content: '在吗' },
        { role: 'assistant', content: '我在的' },
        { role: 'user', content: '怎么还不回' },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool as any).execute({
      riskType: 'escalation',
      reason: '连续追问',
    });

    expect(result.sideEffect.currentMessageContent).toBe('怎么还不回');
  });
});
