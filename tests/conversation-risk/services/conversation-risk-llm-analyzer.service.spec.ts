import { ConversationRiskLlmAnalyzerService } from '@/conversation-risk/services/conversation-risk-llm-analyzer.service';
import type {
  ConversationRiskContext,
  ConversationRiskReviewSignal,
} from '@/conversation-risk/types/conversation-risk.types';
import { CompletionService } from '@/agent/completion.service';

describe('ConversationRiskLlmAnalyzerService', () => {
  const mockCompletion = {
    generateStructured: jest.fn(),
  } as unknown as jest.Mocked<CompletionService>;

  let service: ConversationRiskLlmAnalyzerService;

  const context: ConversationRiskContext = {
    corpId: 'org-1',
    chatId: 'chat-1',
    userId: 'contact-1',
    pauseTargetId: 'chat-1',
    messageId: 'msg-1',
    contactName: '候选人A',
    botImId: 'bot-im-1',
    currentMessageContent: '到底什么情况，怎么还不回？？',
    recentMessages: [
      { role: 'assistant', content: '您好，稍等我查一下。', timestamp: 1712044800000 },
      { role: 'user', content: '在吗', timestamp: 1712044860000 },
      { role: 'user', content: '怎么还不回', timestamp: 1712044920000 },
      { role: 'user', content: '到底什么情况，怎么还不回？？', timestamp: 1712044980000 },
    ],
    sessionState: null,
  };

  const signal: ConversationRiskReviewSignal = {
    suggestedRiskType: 'escalation',
    summary: '候选人近期连续追问，情绪有明显升级趋势',
    reason: '连续追问表达：怎么还不回、到底',
    matchedKeywords: ['怎么还不回', '到底'],
    evidenceMessages: context.recentMessages.filter((message) => message.role === 'user').slice(-2),
  };

  beforeEach(() => {
    service = new ConversationRiskLlmAnalyzerService(mockCompletion);
    jest.clearAllMocks();
  });

  it('should map structured llm hit result to detection payload', async () => {
    mockCompletion.generateStructured.mockResolvedValue({
      object: {
        hit: true,
        riskType: 'escalation',
        riskLabel: null,
        summary: null,
        reason: null,
      },
      usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
    });

    const result = await service.analyze(context, signal);

    expect(mockCompletion.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        outputName: 'ConversationRiskLlmDecision',
        messages: [{ role: 'user', content: expect.any(String) }],
      }),
    );
    expect(result).toEqual({
      hit: true,
      riskType: 'escalation',
      riskLabel: '连续质问/情绪升级',
      summary: signal.summary,
      reason: signal.reason,
      matchedKeywords: signal.matchedKeywords,
      evidenceMessages: signal.evidenceMessages,
      analysisMode: 'llm',
    });
  });

  it('should return no hit when llm says not to escalate', async () => {
    mockCompletion.generateStructured.mockResolvedValue({
      object: {
        hit: false,
        riskType: 'none',
        riskLabel: null,
        summary: '只是普通催促',
        reason: '暂不需要人工介入',
      },
      usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
    });

    await expect(service.analyze(context, signal)).resolves.toEqual({ hit: false });
  });

  it('should swallow llm errors and return no hit', async () => {
    mockCompletion.generateStructured.mockRejectedValue(new Error('provider unavailable'));

    await expect(service.analyze(context, signal)).resolves.toEqual({ hit: false });
  });
});
