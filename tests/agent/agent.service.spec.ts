import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GeneratorService } from '@agent/generator/generator.service';
import { AgentPreparationService } from '@agent/agent-preparation.service';
import { CallerKind } from '@enums/agent.enum';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { MemoryService } from '@memory/memory.service';

jest.mock('ai', () => ({
  stepCountIs: jest.fn().mockReturnValue(() => false),
  hasToolCall: jest.fn().mockReturnValue(() => false),
}));

describe('GeneratorService', () => {
  let service: GeneratorService;

  const mockPreparation = {
    prepare: jest.fn(),
  };

  const mockMemoryService = {
    onTurnEnd: jest.fn().mockResolvedValue(undefined),
  };

  const mockLlm = {
    supportsVisionInput: jest.fn().mockReturnValue(true),
    generate: jest.fn(),
    stream: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => defaultValue),
  };

  const invokeParams = {
    callerKind: CallerKind.TEST_SUITE,
    messages: [{ role: 'user', content: 'Hello' }],
    userId: 'user-123',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messageId: 'msg-1',
  };

  const preparedContext = {
    finalPrompt: 'test system prompt',
    normalizedMessages: [{ role: 'user', content: 'Hello' }],
    tools: {},
    corpId: 'corp-1',
    userId: 'user-123',
    sessionId: 'sess-1',
    maxSteps: 5,
    entryStage: null,
    turnState: { candidatePool: null },
    memorySnapshot: undefined,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeneratorService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AgentPreparationService, useValue: mockPreparation },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: LlmExecutorService, useValue: mockLlm },
      ],
    }).compile();

    service = module.get<GeneratorService>(GeneratorService);
    jest.clearAllMocks();

    mockLlm.supportsVisionInput.mockReturnValue(true);
    mockPreparation.prepare.mockResolvedValue(preparedContext);
    mockMemoryService.onTurnEnd.mockResolvedValue(undefined);
    mockLlm.generate.mockImplementation(async (options: Record<string, unknown>) => {
      const onPreparedRequest = options.onPreparedRequest as
        | ((request: Record<string, unknown>) => Promise<void> | void)
        | undefined;
      await onPreparedRequest?.({
        modelId: 'openai/gpt-5.1',
        fallbackModelIds: ['openai/gpt-5-mini'],
        system: 'test system prompt',
        messages: [{ role: 'user', content: 'Hello' }],
        maxOutputTokens: 4096,
        maxSteps: 5,
      });

      return {
        text: 'Hello!',
        response: {
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }],
        },
        steps: [{}],
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    });
    mockLlm.stream.mockResolvedValue({ textStream: 'stream' });
  });

  it('should prepare with vision capability resolved from llm executor', async () => {
    await service.invoke(invokeParams);

    expect(mockLlm.supportsVisionInput).toHaveBeenCalledWith({
      role: 'chat',
      modelId: undefined,
      disableFallbacks: undefined,
    });
    expect(mockPreparation.prepare).toHaveBeenCalledWith(invokeParams, 'invoke', {
      enableVision: true,
    });
  });

  it('should invoke llm executor and expose prepared request snapshot', async () => {
    const onPreparedRequest = jest.fn();

    const result = await service.invoke({
      ...invokeParams,
      onPreparedRequest,
      modelId: 'openai/gpt-5.1',
      disableFallbacks: true,
      thinking: { type: 'enabled', budgetTokens: 4000 },
    });

    expect(mockLlm.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'chat',
        modelId: 'openai/gpt-5.1',
        disableFallbacks: true,
        thinking: { type: 'enabled', budgetTokens: 4000 },
        system: 'test system prompt',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    );
    expect(onPreparedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'openai/gpt-5.1',
        fallbackModelIds: ['openai/gpt-5-mini'],
      }),
    );
    expect(result.agentRequest).toEqual(
      expect.objectContaining({
        modelId: 'openai/gpt-5.1',
        fallbackModelIds: ['openai/gpt-5-mini'],
      }),
    );
    expect(result.responseMessages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    ]);
  });

  it('should use env thinking budget when request does not override thinking', async () => {
    mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'AGENT_THINKING_BUDGET_TOKENS') return '3000';
      return defaultValue;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeneratorService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AgentPreparationService, useValue: mockPreparation },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: LlmExecutorService, useValue: mockLlm },
      ],
    }).compile();
    service = module.get<GeneratorService>(GeneratorService);

    await service.invoke(invokeParams);

    expect(mockLlm.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: { type: 'enabled', budgetTokens: 3000 },
      }),
    );
  });

  it('should recover empty model text with a no-tool follow-up', async () => {
    mockLlm.generate
      .mockResolvedValueOnce({
        text: '',
        response: {
          messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'need answer' }] }],
        },
        steps: [
          {
            reasoningText: 'checked interview date',
            finishReason: 'tool-calls',
            toolCalls: [
              {
                toolCallId: 'tool-1',
                toolName: 'duliday_interview_precheck',
                input: { jobId: 522935, requestedDate: 'today' },
              },
            ],
            toolResults: [
              {
                toolCallId: 'tool-1',
                output: {
                  success: true,
                  interview: {
                    requestedDate: {
                      status: 'unavailable',
                      reason: '已超过报名截止时间',
                    },
                    upcomingTimeOptions: ['明天下午 1 点半到 5 点'],
                  },
                },
              },
            ],
            usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
          },
        ],
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      })
      .mockResolvedValueOnce({
        text: '今天已经过了报名截止，明天下午 1 点半到 5 点可以。',
        reasoningText: undefined,
        response: {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: '今天已经过了报名截止，明天下午 1 点半到 5 点可以。',
                },
              ],
            },
          ],
        },
        steps: [
          {
            text: '今天已经过了报名截止，明天下午 1 点半到 5 点可以。',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

    const result = await service.invoke(invokeParams);
    const recoveryCall = mockLlm.generate.mock.calls[1][0] as Record<string, unknown>;

    expect(mockLlm.generate).toHaveBeenCalledTimes(2);
    expect(recoveryCall).toEqual(
      expect.objectContaining({
        thinking: { type: 'disabled', budgetTokens: 0 },
      }),
    );
    expect(recoveryCall).not.toHaveProperty('tools');
    expect(recoveryCall).not.toHaveProperty('stopWhen');
    expect(recoveryCall).not.toHaveProperty('prepareStep');
    expect(recoveryCall).not.toHaveProperty('messages');
    expect(recoveryCall.prompt).toContain('对话上下文');
    expect(recoveryCall.prompt).toContain('requestedDate.status=unavailable');
    expect(result.text).toBe('今天已经过了报名截止，明天下午 1 点半到 5 点可以。');
    expect(result.usage.totalTokens).toBe(115);
    expect(result.agentSteps.at(-1)).toEqual(
      expect.objectContaining({
        text: '今天已经过了报名截止，明天下午 1 点半到 5 点可以。',
        finishReason: 'empty-text-recovery',
      }),
    );
    expect(mockMemoryService.onTurnEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
      }),
      '今天已经过了报名截止，明天下午 1 点半到 5 点可以。',
    );
  });

  it('should recover empty text after request_handoff when the tool did not short-circuit', async () => {
    mockLlm.generate
      .mockResolvedValueOnce({
        text: '',
        response: {
          messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'need answer' }] }],
        },
        steps: [
          {
            reasoningText: '候选人要改期，但没有预约记录',
            finishReason: 'tool-calls',
            toolCalls: [
              {
                toolCallId: 'tool-1',
                toolName: 'request_handoff',
                input: { reasonCode: 'modify_appointment' },
              },
            ],
            toolResults: [
              {
                toolCallId: 'tool-1',
                output: {
                  dispatched: false,
                  errorType: 'handoff.no_booking',
                  shortCircuited: false,
                },
              },
            ],
            usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
          },
        ],
        usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      })
      .mockResolvedValueOnce({
        text: '你这边还没有已确认的面试，我先帮你重新约一次。',
        response: {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: '你这边还没有已确认的面试，我先帮你重新约一次。' }],
            },
          ],
        },
        steps: [
          {
            text: '你这边还没有已确认的面试，我先帮你重新约一次。',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

    const result = await service.invoke(invokeParams);

    expect(mockLlm.generate).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('你这边还没有已确认的面试，我先帮你重新约一次。');
    expect(result.agentSteps.at(-1)).toEqual(
      expect.objectContaining({ finishReason: 'empty-text-recovery' }),
    );
  });

  it('should not recover empty text after request_handoff when the tool short-circuited', async () => {
    mockLlm.generate.mockResolvedValueOnce({
      text: '',
      response: {
        messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'handoff' }] }],
      },
      steps: [
        {
          reasoningText: '候选人办理入职，需要人工接管',
          finishReason: 'tool-calls',
          toolCalls: [
            {
              toolCallId: 'tool-1',
              toolName: 'request_handoff',
              input: { reasonCode: 'onboarding_paperwork' },
            },
          ],
          toolResults: [
            {
              toolCallId: 'tool-1',
              output: {
                dispatched: true,
                shortCircuited: true,
              },
            },
          ],
          usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        },
      ],
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });

    const result = await service.invoke(invokeParams);

    expect(mockLlm.generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'request_handoff',
        result: expect.objectContaining({ shortCircuited: true }),
      }),
    ]);
  });

  it('should not recover empty text after any tool returns shortCircuited=true', async () => {
    mockLlm.generate.mockResolvedValueOnce({
      text: '',
      response: {
        messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'gate reject' }] }],
      },
      steps: [
        {
          reasoningText: 'booking gate rejected hard',
          finishReason: 'tool-calls',
          toolCalls: [
            {
              toolCallId: 'tool-1',
              toolName: 'duliday_interview_booking',
              input: { jobId: 123 },
            },
          ],
          toolResults: [
            {
              toolCallId: 'tool-1',
              output: {
                shortCircuited: true,
                gateRejected: true,
                reasonCode: 'job_id_not_recalled',
              },
            },
          ],
          usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        },
      ],
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });

    const result = await service.invoke(invokeParams);

    expect(mockLlm.generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'duliday_interview_booking',
        result: expect.objectContaining({ shortCircuited: true, gateRejected: true }),
      }),
    ]);
  });

  it('should enrich thrown model errors with agent metadata', async () => {
    mockLlm.generate.mockRejectedValue(new Error('Network timeout'));

    const error = await service.invoke(invokeParams).catch((err) => err);

    expect(error).toMatchObject({
      message: 'Network timeout',
      isAgentError: true,
      agentMeta: expect.objectContaining({
        sessionId: 'sess-1',
        userId: 'user-123',
        messageCount: 1,
      }),
    });
  });

  it('should include memory warning when messages are empty', async () => {
    mockPreparation.prepare.mockResolvedValue({
      ...preparedContext,
      normalizedMessages: [],
      memoryLoadWarning: 'shortTerm: Connection timeout',
    });

    const error = await service.invoke(invokeParams).catch((err) => err);

    expect(error.message).toContain('sessionId=sess-1');
    expect(error.message).toContain('memoryWarning=shortTerm: Connection timeout');
    expect(error).toMatchObject({
      isAgentError: true,
      agentMeta: expect.objectContaining({
        sessionId: 'sess-1',
        userId: 'user-123',
        messageCount: 0,
        memoryLoadWarning: 'shortTerm: Connection timeout',
      }),
    });
  });

  it('should trigger turn-end lifecycle without blocking invoke success', async () => {
    mockPreparation.prepare.mockResolvedValue({
      ...preparedContext,
      normalizedMessages: [
        { role: 'assistant', content: '之前给你推荐了长白门店。' },
        { role: 'user', content: '我想报名长白' },
      ],
      turnState: {
        candidatePool: [{ jobId: 519709, brandName: '奥乐齐', storeName: '长白' }],
      },
    });
    mockMemoryService.onTurnEnd.mockRejectedValue(new Error('memory lifecycle failed'));

    await expect(
      service.invoke({
        ...invokeParams,
        messages: [
          { role: 'assistant', content: '之前给你推荐了长白门店。' },
          { role: 'user', content: '我想报名长白' },
        ],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        text: 'Hello!',
        steps: 1,
      }),
    );

    expect(mockMemoryService.onTurnEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'corp-1',
        userId: 'user-123',
        sessionId: 'sess-1',
        messageId: 'msg-1',
      }),
      'Hello!',
    );
  });
});
