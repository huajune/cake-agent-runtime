import { ConversationRiskDetectorService } from '@/conversation-risk/services/conversation-risk-detector.service';
import { ConversationRiskContext } from '@/conversation-risk/types/conversation-risk.types';

describe('ConversationRiskDetectorService', () => {
  let service: ConversationRiskDetectorService;

  const baseContext: ConversationRiskContext = {
    corpId: 'org-1',
    chatId: 'chat-1',
    userId: 'contact-1',
    pauseTargetId: 'chat-1',
    messageId: 'msg-1',
    contactName: '候选人A',
    botImId: '1688855974513959',
    currentMessageContent: '你好',
    recentMessages: [
      { role: 'assistant', content: '你好，有什么可以帮你？', timestamp: 1712044800000 },
      { role: 'user', content: '你好', timestamp: 1712044860000 },
    ],
    sessionState: null,
  };

  beforeEach(() => {
    service = new ConversationRiskDetectorService();
  });

  it('should detect abuse keywords', () => {
    const result = service.detect({
      ...baseContext,
      currentMessageContent: '你们这帮人真是垃圾',
      recentMessages: [
        ...baseContext.recentMessages,
        { role: 'user', content: '你们这帮人真是垃圾', timestamp: 1712044920000 },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        hit: true,
        riskType: 'abuse',
        riskLabel: '辱骂/攻击',
      }),
    );
    expect(result.reason).toContain('垃圾');
  });

  it('should detect complaint risk keywords', () => {
    const result = service.detect({
      ...baseContext,
      currentMessageContent: '你们是不是骗子，我要投诉',
      recentMessages: [
        ...baseContext.recentMessages,
        { role: 'user', content: '你们是不是骗子，我要投诉', timestamp: 1712044920000 },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        hit: true,
        riskType: 'complaint_risk',
        riskLabel: '投诉/举报风险',
      }),
    );
    expect(result.reason).toContain('投诉');
  });

  it('should ignore historical risk keywords outside the current unresponded turn', () => {
    const result = service.detect({
      ...baseContext,
      currentMessageContent: '好的我知道了',
      recentMessages: [
        { role: 'assistant', content: '您好，有什么可以帮您？', timestamp: 1712044800000 },
        { role: 'user', content: '我要投诉你们', timestamp: 1712044860000 },
        { role: 'assistant', content: '抱歉给您带来困扰', timestamp: 1712044920000 },
        { role: 'user', content: '好的我知道了', timestamp: 1712044980000 },
      ],
    });

    expect(result).toEqual({ hit: false });
  });

  it('should build llm review signal for repeated escalation messages', () => {
    const context: ConversationRiskContext = {
      ...baseContext,
      currentMessageContent: '到底什么情况，怎么还不回？？',
      recentMessages: [
        { role: 'assistant', content: '您好，稍等我查一下。', timestamp: 1712044800000 },
        { role: 'user', content: '在吗', timestamp: 1712044860000 },
        { role: 'user', content: '怎么还不回', timestamp: 1712044920000 },
        { role: 'user', content: '到底什么情况，怎么还不回？？', timestamp: 1712044980000 },
      ],
    };

    expect(service.detect(context)).toEqual({ hit: false });

    const result = service.buildLlmReviewSignal(context);

    expect(result).toEqual(
      expect.objectContaining({
        suggestedRiskType: 'escalation',
        summary: '候选人近期连续追问，情绪有明显升级趋势',
      }),
    );
    expect(result?.reason).toContain('怎么还');
    expect(result?.evidenceMessages).toHaveLength(3);
  });

  it('should build llm review signal for soft negative expressions', () => {
    const result = service.buildLlmReviewSignal({
      ...baseContext,
      currentMessageContent: '这也太离谱了，感觉你们在耍我',
      recentMessages: [
        { role: 'assistant', content: '您先别着急，我帮您确认。', timestamp: 1712044800000 },
        { role: 'user', content: '这也太离谱了，感觉你们在耍我', timestamp: 1712044860000 },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        suggestedRiskType: 'escalation',
        summary: '候选人出现明显负面情绪，需要结合上下文做复判',
      }),
    );
    expect(result?.reason).toContain('离谱');
  });
});
