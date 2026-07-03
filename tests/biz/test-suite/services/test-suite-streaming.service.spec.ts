import { EventEmitter } from 'node:events';
import { TestSuiteStreamingService } from '@biz/test-suite/services/test-suite-streaming.service';

describe('TestSuiteStreamingService', () => {
  const executionService = {
    executeTestStream: jest.fn(),
    convertVercelAIToTestRequest: jest.fn(),
    executeTestStreamWithMeta: jest.fn(),
  };
  const aiStreamObservability = {
    startTrace: jest.fn(),
  };
  const outputGuard = {
    check: jest.fn(),
  };
  const service = new TestSuiteStreamingService(
    executionService as any,
    aiStreamObservability as any,
    outputGuard as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeResponse() {
    return {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
    };
  }

  it('pipes executeTestStream chunks through the SSE response', async () => {
    const stream = new EventEmitter();
    executionService.executeTestStream.mockResolvedValue(stream);
    const res = makeResponse();

    await service.testChatStream({ message: 'hi' } as any, res as any);
    stream.emit('data', Buffer.from('data: {"type":"text-delta","delta":"hello"}\n\n'));
    stream.emit('end');

    expect(executionService.executeTestStream).toHaveBeenCalledWith({ message: 'hi' });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('event: start'));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('hello'));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('event: done'));
    expect(res.end).toHaveBeenCalled();
  });

  it('builds advisory guardrail trace from the accumulated review input', async () => {
    outputGuard.check.mockResolvedValue({
      decision: 'revise',
      riskLevel: 'medium',
      ruleIds: ['salary_fabrication'],
      blockedRuleIds: ['salary_fabrication'],
      violations: [{ type: 'bad_fact' }],
      repairMode: 'rewrite',
      reasonCode: 'rule_hit',
    });
    const trace = {
      getReviewInput: () => ({ reply: '错误回复', toolCalls: [{ toolName: 'duliday_job_list' }] }),
    };

    await expect((service as any).buildAdvisoryGuardrail(trace, '用户消息')).resolves.toMatchObject(
      {
        finalDecision: 'revise',
        reasonCode: 'rule_hit',
        steps: [
          expect.objectContaining({
            decision: 'revise',
            riskLevel: 'medium',
            ruleIds: ['salary_fabrication'],
            violationTypes: ['bad_fact'],
          }),
        ],
      },
    );
    expect(outputGuard.check).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: '错误回复',
        userMessage: '用户消息',
        silent: true,
      }),
    );
  });

  it('skips advisory guardrail for blank replies and swallows guardrail failures', async () => {
    await expect(
      (service as any).buildAdvisoryGuardrail(
        { getReviewInput: () => ({ reply: '   ', toolCalls: [] }) },
        '用户消息',
      ),
    ).resolves.toBeNull();

    outputGuard.check.mockRejectedValue(new Error('guard down'));
    await expect(
      (service as any).buildAdvisoryGuardrail(
        { getReviewInput: () => ({ reply: '回复', toolCalls: [] }) },
        '用户消息',
      ),
    ).resolves.toBeNull();
  });
});
