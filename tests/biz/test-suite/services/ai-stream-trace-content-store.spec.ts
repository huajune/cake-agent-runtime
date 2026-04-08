import { AiStreamTraceContentStore } from '@biz/test-suite/services/ai-stream-trace-content-store';
import { AiStreamSummaryPayload } from '@biz/test-suite/services/ai-stream-trace';

describe('AiStreamTraceContentStore', () => {
  const basePayload: AiStreamSummaryPayload = {
    traceId: 'trace-1',
    sessionId: 'session-1',
    scenario: 'candidate-consultation',
    status: 'success',
    entryStage: 'trust_building',
    chunkTypeCounts: {},
    stepCount: 0,
    tools: [],
    hasReasoning: false,
    hasText: false,
    timings: {
      timestamps: { receivedAt: 1, completedAt: 2 },
      durations: { totalMs: 1 },
    },
  };

  it('should aggregate text, reasoning and tool calls into a stored response', () => {
    const store = new AiStreamTraceContentStore();

    store.recordChunkType('reasoning-start');
    store.startReasoningBlock('reasoning-1');
    store.appendReasoningDelta('reasoning-1', '先分析一下');
    store.recordChunkType('text-start');
    store.startTextBlock('text-1');
    store.appendTextDelta('text-1', '这是回复');
    store.beginToolInput('tool-1', { toolName: 'search' });
    store.appendToolInputDelta('tool-1', '{"q":"上海兼职"}');
    store.setToolOutputAvailable('tool-1', { output: { total: 3 } });

    const response = store.buildStoredResponse(
      {
        ...basePayload,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        chunkTypeCounts: store.getChunkTypeCounts(),
        stepCount: store.getStepCount(),
        tools: store.getTools(),
        hasReasoning: store.hasReasoning(),
        hasText: store.hasText(),
        replyPreview: store.getReplyPreview(),
        reasoningPreview: store.getReasoningPreview(),
      },
      'trace-1',
    );

    expect(response.reply).toEqual(
      expect.objectContaining({
        content: '这是回复',
        reasoning: '先分析一下',
      }),
    );
    expect(response.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'search',
        input: { q: '上海兼职' },
        output: { total: 3 },
      }),
    ]);
    expect(response.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-trace-1',
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', text: '先分析一下' }),
          expect.objectContaining({ type: 'text', text: '这是回复' }),
          expect.objectContaining({ type: 'tool-search', toolCallId: 'tool-1' }),
        ]),
      }),
    ]);
  });

  it('should keep raw tool input text when it is not valid JSON', () => {
    const store = new AiStreamTraceContentStore();

    store.beginToolInput('tool-2', { toolName: 'search' });
    store.appendToolInputDelta('tool-2', 'q=上海兼职');
    store.setToolInputError('tool-2', { errorText: 'bad request' });

    const response = store.buildStoredResponse(
      {
        ...basePayload,
        status: 'failure',
        error: 'boom',
        chunkTypeCounts: store.getChunkTypeCounts(),
        stepCount: store.getStepCount(),
        tools: store.getTools(),
        hasReasoning: store.hasReasoning(),
        hasText: store.hasText(),
        replyPreview: store.getReplyPreview(),
        reasoningPreview: store.getReasoningPreview(),
      },
      'trace-2',
      'boom',
    );

    expect(response.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'search',
        input: 'q=上海兼职',
        errorText: 'bad request',
      }),
    ]);
  });
});
