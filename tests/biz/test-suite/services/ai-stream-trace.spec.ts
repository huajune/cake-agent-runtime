import { AiStreamTrace } from '@biz/test-suite/services/ai-stream-trace';

describe('AiStreamTrace', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should record the trace lifecycle and emit success observability events', () => {
    const trace = new AiStreamTrace(mockTrackingService as never, mockObserver as never, {
      chatId: 'session-success',
      userId: 'user-1',
      scenario: 'candidate-consultation',
      messageText: 'hello',
      requestBody: {
        normalizedRequest: { message: 'hello' },
      },
    });

    trace.markAiStart();
    trace.markStreamReady('trust_building');
    trace.markResponsePipeStart();
    trace.observeChunk({ type: 'text-start', id: 'text-1' } as const);
    trace.observeChunk({ type: 'text-delta', id: 'text-1', delta: 'first reply' } as const);
    trace.observeChunk({ type: 'finish', finishReason: 'stop' } as const);
    trace.recordUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    trace.finalizeSuccess();

    expect(mockTrackingService.recordMessageReceived).toHaveBeenCalledTimes(1);
    expect(mockTrackingService.recordWorkerStart).toHaveBeenCalledTimes(1);
    expect(mockTrackingService.recordAiStart).toHaveBeenCalledTimes(1);
    expect(mockTrackingService.recordAiEnd).toHaveBeenCalledTimes(1);
    expect(mockTrackingService.recordSendStart).toHaveBeenCalledTimes(1);
    expect(mockTrackingService.recordSendEnd).toHaveBeenCalledTimes(1);
    expect(mockTrackingService.recordSuccess).toHaveBeenCalledTimes(1);

    expect(mockObserver.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_start',
        userId: 'user-1',
        scenario: 'candidate-consultation',
      }),
    );
    expect(mockObserver.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_stream_timing',
        status: 'success',
        sessionId: 'session-success',
      }),
    );
    expect(mockObserver.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_end',
        totalTokens: 15,
      }),
    );
  });

  it('should persist failure metadata and emit an agent_error event', () => {
    const trace = new AiStreamTrace(mockTrackingService as never, mockObserver as never, {
      chatId: 'session-failure',
      userId: 'user-2',
      requestBody: {
        normalizedRequest: { message: 'fail please' },
      },
    });

    trace.markAiStart();
    trace.markResponsePipeStart();
    trace.observeChunk({ type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'search' } as const);
    trace.observeChunk({ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"q":"abc"}' } as const);
    trace.finalizeFailure(new Error('boom'));

    expect(mockTrackingService.recordFailure).toHaveBeenCalledTimes(1);

    const [, errorMessage, metadata] = mockTrackingService.recordFailure.mock.calls[0];
    expect(errorMessage).toBe('boom');
    expect(metadata.agentInvocation.response).toEqual(
      expect.objectContaining({
        error: 'boom',
        toolCalls: [
          expect.objectContaining({
            toolName: 'search',
            input: { q: 'abc' },
          }),
        ],
      }),
    );

    expect(mockObserver.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_error',
        userId: 'user-2',
        error: 'boom',
      }),
    );
    expect(mockObserver.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_stream_timing',
        status: 'failure',
        error: 'boom',
      }),
    );
  });
});
