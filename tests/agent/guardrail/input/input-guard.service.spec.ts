import { InputGuardrailService } from '@agent/guardrail/input/input-guard.service';

describe('InputGuardrailService', () => {
  const riskIntercept = {
    evaluate: jest.fn(),
  };

  let service: InputGuardrailService;

  beforeEach(() => {
    jest.clearAllMocks();
    riskIntercept.evaluate.mockResolvedValue({ hit: false });
    service = new InputGuardrailService(riskIntercept as never);
  });

  it('returns pass when input risk guard passes', async () => {
    await expect(
      service.evaluate({
        corpId: 'corp-1',
        chatId: 'chat-1',
        userId: 'user-1',
        pauseTargetId: 'chat-1',
        scanContent: '你好',
      }),
    ).resolves.toEqual({ decision: 'pass' });

    expect(riskIntercept.evaluate).toHaveBeenCalledWith({
      corpId: 'corp-1',
      chatId: 'chat-1',
      userId: 'user-1',
      pauseTargetId: 'chat-1',
      scanContent: '你好',
    });
  });

  it('returns block decision when high-confidence input risk hits', async () => {
    riskIntercept.evaluate.mockResolvedValue({
      hit: true,
      riskType: 'complaint_risk',
      label: '投诉/举报风险',
      reason: '命中关键词：投诉',
      sideEffect: {
        kind: 'conversation_risk',
        source: 'regex_intercept',
        riskType: 'complaint_risk',
        riskLabel: '投诉/举报风险',
        summary: '候选人出现明确投诉、举报或欺骗风险表达',
        reason: '命中关键词：投诉',
      },
    });

    await expect(
      service.evaluate({
        corpId: 'corp-1',
        chatId: 'chat-1',
        userId: 'user-1',
        pauseTargetId: 'chat-1',
        scanContent: '我要投诉',
      }),
    ).resolves.toEqual({
      decision: 'block',
      source: 'input_risk',
      disposition: 'side_effects',
      reasonCode: 'complaint_risk',
      riskType: 'complaint_risk',
      riskLabel: '投诉/举报风险',
      reason: '命中关键词：投诉',
      inspectedText: '我要投诉',
      sideEffects: [
        expect.objectContaining({
          kind: 'conversation_risk',
          source: 'regex_intercept',
          riskType: 'complaint_risk',
        }),
      ],
    });
  });

  it('keeps precheckInputRisk compatibility for existing callers', async () => {
    riskIntercept.evaluate.mockResolvedValue({
      hit: true,
      riskType: 'abuse',
      label: '辱骂/攻击',
      reason: '命中关键词：滚',
    });

    await expect(
      service.precheckInputRisk({
        corpId: 'corp-1',
        chatId: 'chat-1',
        userId: 'user-1',
        pauseTargetId: 'chat-1',
        scanContent: '滚',
      }),
    ).resolves.toEqual({
      hit: true,
      riskType: 'abuse',
      label: '辱骂/攻击',
      reason: '命中关键词：滚',
    });
  });
});
