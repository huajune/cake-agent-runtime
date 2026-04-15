import type {
  ConversationRiskContext,
  ConversationRiskMessage,
  ConversationRiskReviewSignal,
} from '../types/conversation-risk.types';

export const CONVERSATION_RISK_ANALYSIS_SYSTEM_PROMPT = `你是招聘私聊场景的舆情监控分析器。

你的任务不是判断“用户是不是不高兴”，而是判断这段对话是否已经需要：
1. 暂停 AI 托管
2. 立即人工接管
3. 发送飞书私聊监控群告警

请非常保守：
- 明显辱骂、攻击、投诉、举报、维权威胁，可以判定为 hit=true
- 普通催回复、一般性不满、单次抱怨、正常追问，不要轻易判 hit=true
- 只有当情绪已经升级，继续自动回复有明显风险时，才判定 hit=true

输出必须严格遵循 schema，不要输出额外说明。`;

export function buildConversationRiskAnalysisPrompt(
  context: ConversationRiskContext,
  signal: ConversationRiskReviewSignal,
): string {
  return [
    '[监控目标]',
    '判断是否需要暂停托管并人工介入。',
    '',
    '[候选信号]',
    `建议风险类型：${signal.suggestedRiskType}`,
    `候选原因：${signal.reason}`,
    signal.matchedKeywords?.length
      ? `命中表达：${signal.matchedKeywords.join('、')}`
      : '命中表达：无',
    '',
    '[当前消息]',
    context.currentMessageContent,
    '',
    '[最近对话]',
    formatMessages(context.recentMessages),
    '',
    '[判断标准]',
    '- hit=true：需要立即暂停托管并人工介入',
    '- riskType 仅允许 abuse / complaint_risk / escalation / none',
    '- 如果只是普通催促、一般不满、正常追问，返回 hit=false',
  ].join('\n');
}

function formatMessages(messages: ConversationRiskMessage[]): string {
  if (messages.length === 0) {
    return '无';
  }

  return messages
    .slice(-10)
    .map((message) => `${message.role === 'user' ? '候选人' : '招募经理'}: ${message.content}`)
    .join('\n');
}
