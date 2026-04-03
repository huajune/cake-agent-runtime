import { AiStreamObservabilityService } from '@biz/test-suite/services/ai-stream-observability.service';

describe('AiStreamObservabilityService', () => {
  const mockTrackingService = {
    recordMessageReceived: jest.fn(),
    recordWorkerStart: jest.fn(),
    recordAiStart: jest.fn(),
    recordAiEnd: jest.fn(),
    recordSendStart: jest.fn(),
    recordSendEnd: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };

  const mockObserver = {
    emit: jest.fn(),
  };

  let service: AiStreamObservabilityService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AiStreamObservabilityService(
      mockTrackingService as never,
      mockObserver as never,
    );
  });

  it('should persist full ai-stream request, reply, reasoning, tool calls and renderable messages', () => {
    const trace = service.startTrace({
      chatId: 'session-1',
      userId: 'dashboard-test-001',
      scenario: 'candidate-consultation',
      messageText: '上海杨浦肯德基',
      requestBody: {
        normalizedRequest: {
          message: '上海杨浦肯德基',
        },
      },
    });

    trace.mergeRequestBody({
      agentRequest: {
        messages: [{ role: 'user', content: '上海杨浦肯德基' }],
        strategySource: 'testing',
      },
    });
    trace.markAiStart();
    trace.markStreamReady('trust_building');
    trace.markResponsePipeStart();

    trace.observeChunk({
      type: 'reasoning-start',
      id: 'reasoning-1',
    } as const);
    trace.observeChunk({
      type: 'reasoning-delta',
      id: 'reasoning-1',
      delta: '1. **先读记忆，再做判断**',
    } as const);
    trace.observeChunk({
      type: 'tool-input-start',
      toolCallId: 'tool-1',
      toolName: 'duliday_job_list',
    } as const);
    trace.observeChunk({
      type: 'tool-input-available',
      toolCallId: 'tool-1',
      toolName: 'duliday_job_list',
      input: {
        brand: '肯德基',
        city: '上海',
        area: '杨浦',
      },
    } as const);
    trace.observeChunk({
      type: 'tool-output-available',
      toolCallId: 'tool-1',
      output: {
        total: 2,
      },
    } as const);
    trace.observeChunk({
      type: 'text-start',
      id: 'text-1',
    } as const);
    trace.observeChunk({
      type: 'text-delta',
      id: 'text-1',
      delta: '杨浦这边有两家',
    } as const);
    trace.observeChunk({
      type: 'text-delta',
      id: 'text-1',
      delta: '肯德基在招。',
    } as const);
    trace.observeChunk({
      type: 'finish',
      finishReason: 'stop',
    } as const);

    trace.recordUsage({
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
    });
    trace.finalizeSuccess();

    expect(mockTrackingService.recordSuccess).toHaveBeenCalledTimes(1);

    const [, metadata] = mockTrackingService.recordSuccess.mock.calls[0];
    const invocation = metadata.agentInvocation;

    expect(metadata.replySegments).toBe(1);

    expect(invocation.request).toEqual(
      expect.objectContaining({
        agentRequest: expect.objectContaining({
          strategySource: 'testing',
        }),
      }),
    );

    expect(invocation.response).toEqual(
      expect.objectContaining({
        reply: expect.objectContaining({
          content: '杨浦这边有两家肯德基在招。',
          reasoning: '1. **先读记忆，再做判断**',
          usage: expect.objectContaining({
            totalTokens: 200,
          }),
        }),
        toolCalls: [
          expect.objectContaining({
            toolName: 'duliday_job_list',
            input: expect.objectContaining({
              brand: '肯德基',
            }),
            output: expect.objectContaining({
              total: 2,
            }),
            state: 'output-available',
          }),
        ],
        messages: [
          expect.objectContaining({
            role: 'assistant',
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: 'reasoning',
                text: '1. **先读记忆，再做判断**',
              }),
              expect.objectContaining({
                type: 'tool-duliday_job_list',
                toolName: 'duliday_job_list',
              }),
              expect.objectContaining({
                type: 'text',
                text: '杨浦这边有两家肯德基在招。',
              }),
            ]),
          }),
        ],
      }),
    );
  });
});
