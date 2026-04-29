import { Test, TestingModule } from '@nestjs/testing';
import { TestExecutionService } from '@biz/test-suite/services/test-execution.service';
import { TestExecutionRepository } from '@biz/test-suite/repositories/test-execution.repository';
import { AgentRunnerService } from '@agent/runner.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ExecutionStatus } from '@biz/test-suite/enums/test.enum';
import { TestChatRequestDto } from '@biz/test-suite/dto/test-chat.dto';
import { MessageRole } from '@enums/message.enum';

describe('TestExecutionService', () => {
  let service: TestExecutionService;
  let loop: jest.Mocked<AgentRunnerService>;
  let executionRepository: jest.Mocked<TestExecutionRepository>;

  const mockLoop = {
    invoke: jest.fn(),
    stream: jest.fn(),
  };

  const mockExecutionRepository = {
    findById: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateByBatchAndCase: jest.fn(),
    countCompletedByBatchId: jest.fn(),
  };

  const mockChatSessionService = {
    saveMessagesBatch: jest.fn(),
    saveMessage: jest.fn(),
  };

  const makeSuccessResult = (text = 'Agent reply') => ({
    text,
    steps: 1,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestExecutionService,
        { provide: AgentRunnerService, useValue: mockLoop },
        { provide: TestExecutionRepository, useValue: mockExecutionRepository },
        { provide: ChatSessionService, useValue: mockChatSessionService },
      ],
    }).compile();

    service = module.get<TestExecutionService>(TestExecutionService);
    loop = module.get(AgentRunnerService);
    executionRepository = module.get(TestExecutionRepository);

    jest.clearAllMocks();
    mockChatSessionService.saveMessagesBatch.mockResolvedValue(0);
    mockChatSessionService.saveMessage.mockResolvedValue(true);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== executeTest ==========

  describe('executeTest', () => {
    const baseRequest: TestChatRequestDto = {
      message: '你好，请问还在招人吗',
      userId: 'user-001',
      scenario: 'candidate-consultation',
      saveExecution: false,
    };

    it('should throw error when userId is missing', async () => {
      const request = { ...baseRequest, userId: undefined };

      await expect(service.executeTest(request as TestChatRequestDto)).rejects.toThrow(
        'userId 是必填项',
      );
    });

    it('should execute test and return response with SUCCESS status', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult('AI回复'));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.SUCCESS);
      expect(result.actualOutput).toBe('AI回复');
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.response.statusCode).toBe(200);
    });

    it('should persist prior history into production chat storage before preprocessing', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult('AI回复'));

      await service.executeTest({
        ...baseRequest,
        history: [
          { role: MessageRole.USER, content: '你好' },
          { role: MessageRole.ASSISTANT, content: '在的' },
        ],
        skipHistoryTrim: true,
      });

      expect(mockChatSessionService.saveMessagesBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: '你好', chatId: expect.any(String) }),
          expect.objectContaining({
            role: 'assistant',
            content: '在的',
            chatId: expect.any(String),
          }),
        ]),
      );
      expect(mockChatSessionService.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: '你好，请问还在招人吗',
          chatId: expect.any(String),
        }),
      );
    });

    it('should keep same-turn user history while removing only duplicated current message', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult('AI回复'));

      await service.executeTest({
        ...baseRequest,
        message: '王静怡，38，13816246197，大专',
        history: [
          { role: MessageRole.ASSISTANT, content: '你看这周哪天方便过来面试？' },
          { role: MessageRole.USER, content: '这周三下午行吗' },
          { role: MessageRole.USER, content: '王静怡，38，13816246197，大专' },
        ],
      });

      expect(loop.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'assistant',
              content: '你看这周哪天方便过来面试？',
              imageUrls: undefined,
            },
            { role: 'user', content: '这周三下午行吗', imageUrls: undefined },
            { role: 'user', content: '王静怡，38，13816246197，大专', imageUrls: undefined },
          ],
        }),
      );
    });

    it('should drop future history after the selected current message', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult('AI回复'));

      await service.executeTest({
        ...baseRequest,
        message: '这边我5月1号回来面试可以吗',
        history: [
          { role: MessageRole.ASSISTANT, content: '门店和岗位是银泰3F的哈根达斯。' },
          { role: MessageRole.USER, content: '这边我5月1号回来面试可以吗' },
          { role: MessageRole.ASSISTANT, content: '5月1号可以的。' },
          { role: MessageRole.USER, content: '这边我5月5日回来面试可以吗' },
        ],
      });

      expect(loop.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'assistant',
              content: '门店和岗位是银泰3F的哈根达斯。',
              imageUrls: undefined,
            },
            {
              role: 'user',
              content: '这边我5月1号回来面试可以吗',
              imageUrls: undefined,
            },
          ],
        }),
      );
    });

    it('should return TIMEOUT status when timeout error is thrown', async () => {
      mockLoop.invoke.mockRejectedValue(new Error('Request timeout exceeded'));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.TIMEOUT);
    });

    it('should return FAILURE status for non-timeout errors', async () => {
      mockLoop.invoke.mockRejectedValue(new Error('Network error'));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.FAILURE);
    });

    it('should mark empty non-skip replies as failure', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult(''));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.FAILURE);
      expect(result.response.statusCode).toBe(500);
      expect(result.response.body).toEqual(
        expect.objectContaining({
          text: '',
          toolCalls: [],
        }),
      );
    });

    it('should allow intentional skip_reply to produce an empty success', async () => {
      mockLoop.invoke.mockResolvedValue({
        ...makeSuccessResult(''),
        toolCalls: [
          {
            toolName: 'skip_reply',
            args: { reason: '用户确认结束' },
            result: { skipped: true },
          },
        ],
      } as any);

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.SUCCESS);
      expect(result.actualOutput).toBe('');
      expect(result.response.statusCode).toBe(200);
    });

    it('should save execution record when saveExecution is true', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());
      mockExecutionRepository.create.mockResolvedValue({ id: 'exec-1' } as any);

      const request = { ...baseRequest, saveExecution: true, batchId: 'batch-1' };
      const result = await service.executeTest(request);

      expect(executionRepository.create).toHaveBeenCalledTimes(1);
      expect(result.executionId).toBe('exec-1');
    });

    it('should not save execution record when saveExecution is false', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());

      await service.executeTest({ ...baseRequest, saveExecution: false });

      expect(executionRepository.create).not.toHaveBeenCalled();
    });

    it('should save execution record by default when saveExecution is not set', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());
      mockExecutionRepository.create.mockResolvedValue({ id: 'exec-2' } as any);

      const request = { ...baseRequest };
      delete (request as Partial<TestChatRequestDto>).saveExecution;
      await service.executeTest(request);

      expect(executionRepository.create).toHaveBeenCalled();
    });

    it('should call loop.invoke with correct params', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());

      await service.executeTest(baseRequest);

      expect(loop.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-001',
          corpId: 'test',
          scenario: 'candidate-consultation',
        }),
      );
    });

    it('should switch to released strategy when bot ids are provided', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());

      await service.executeTest({
        ...baseRequest,
        botUserId: 'bot-user-1',
        botImId: 'im-bot-1',
      });

      expect(loop.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          strategySource: 'released',
          botUserId: 'bot-user-1',
          botImId: 'im-bot-1',
        }),
      );
    });

    it('should use default scenario when none is provided', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());

      const request = { ...baseRequest, scenario: undefined };
      await service.executeTest(request);

      expect(loop.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ scenario: 'candidate-consultation' }),
      );
    });

    it('should preserve non-duplicated history and append current message', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());

      const history = [
        { role: MessageRole.USER, content: 'h1' },
        { role: MessageRole.ASSISTANT, content: 'h2' },
        { role: MessageRole.USER, content: 'h3' },
        { role: MessageRole.ASSISTANT, content: 'h4' },
      ];
      await service.executeTest({ ...baseRequest, history });

      const callArgs = loop.invoke.mock.calls[0][0];
      expect(callArgs.messages).toHaveLength(5);
      expect(callArgs.messages.slice(0, -1)).toEqual([
        { role: 'user', content: 'h1', imageUrls: undefined },
        { role: 'assistant', content: 'h2', imageUrls: undefined },
        { role: 'user', content: 'h3', imageUrls: undefined },
        { role: 'assistant', content: 'h4', imageUrls: undefined },
      ]);
      expect(callArgs.messages[callArgs.messages.length - 1]).toEqual({
        role: 'user',
        content: baseRequest.message,
        imageUrls: undefined,
      });
    });

    it('should include token usage in metrics', async () => {
      mockLoop.invoke.mockResolvedValue(makeSuccessResult());

      const result = await service.executeTest(baseRequest);

      expect(result.metrics.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      });
    });

    it('should return zero token usage when loop throws', async () => {
      mockLoop.invoke.mockRejectedValue(new Error('fail'));

      const result = await service.executeTest(baseRequest);

      expect(result.metrics.tokenUsage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      });
    });
  });

  // ========== executeTestStream ==========

  describe('executeTestStream', () => {
    it('should throw error when userId is missing', async () => {
      const request: TestChatRequestDto = {
        message: 'test',
        userId: undefined as unknown as string,
      };

      await expect(service.executeTestStream(request)).rejects.toThrow('userId 是必填项');
    });

    it('should return a readable stream', async () => {
      const { Readable } = require('stream');
      const mockNodeStream = { pipe: jest.fn() } as unknown as NodeJS.ReadableStream;
      const fromWebSpy = jest.spyOn(Readable, 'fromWeb').mockReturnValue(mockNodeStream);

      mockLoop.stream.mockResolvedValue({
        streamResult: { textStream: {} },
        entryStage: 'trust_building',
      } as any);

      const result = await service.executeTestStream({
        message: 'hello',
        userId: 'user-1',
      });

      expect(result).toBe(mockNodeStream);
      fromWebSpy.mockRestore();
    });

    it('should trigger monitoring hooks before stream execution', async () => {
      mockLoop.stream.mockResolvedValue({
        streamResult: { textStream: {} },
        entryStage: 'trust_building',
      } as any);

      await service.executeTestStreamWithMeta({
        message: 'hello',
        userId: 'user-1',
      });

      expect(mockChatSessionService.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: 'hello',
        }),
      );
      expect(loop.stream).toHaveBeenCalled();
    });

    it('should not attach legacy booking callback to stream params', async () => {
      mockLoop.stream.mockResolvedValue({
        streamResult: { textStream: {} },
        entryStage: 'trust_building',
      } as any);

      await service.executeTestStreamWithMeta({
        message: 'hello',
        userId: 'user-1',
        sessionId: 'sess-stream',
      });

      const runnerParams = mockLoop.stream.mock.calls[0][0];
      expect(runnerParams.sessionId).toBe('sess-stream');
      expect(runnerParams).not.toHaveProperty('onFinish');
    });

    it('should switch stream strategy to released when bot ids are provided', async () => {
      mockLoop.stream.mockResolvedValue({
        streamResult: { textStream: {} },
        entryStage: 'trust_building',
      } as any);

      await service.executeTestStreamWithMeta({
        message: 'hello',
        userId: 'user-1',
        botUserId: 'bot-user-1',
        botImId: 'im-bot-1',
      });

      const runnerParams = mockLoop.stream.mock.calls[0][0];
      expect(runnerParams).toEqual(
        expect.objectContaining({
          strategySource: 'released',
          botUserId: 'bot-user-1',
          botImId: 'im-bot-1',
        }),
      );
    });
  });

  describe('resolveHistoryForAgent', () => {
    type HistoryRequest = Pick<TestChatRequestDto, 'history' | 'message' | 'skipHistoryTrim'>;
    type HistoryMessage = { role: MessageRole; content: string; imageUrls?: string[] };

    const resolveHistoryForAgent = (request: HistoryRequest): HistoryMessage[] =>
      (
        service as unknown as {
          resolveHistoryForAgent(request: HistoryRequest): HistoryMessage[];
        }
      ).resolveHistoryForAgent(request);

    it('should trim history before the latest matching current user message', () => {
      const history = [
        { role: MessageRole.USER, content: '我5月1号回来面试可以吗' },
        { role: MessageRole.ASSISTANT, content: '我先帮你查' },
        { role: MessageRole.USER, content: ' 我5月1号回来面试可以吗 ' },
        { role: MessageRole.ASSISTANT, content: '未来助手回复，不应进入本轮' },
      ];

      expect(
        resolveHistoryForAgent({
          history,
          message: '我5月1号回来面试可以吗',
        }),
      ).toEqual(history.slice(0, 2));
    });

    it('should keep history unchanged when current message is not found', () => {
      const history = [
        { role: MessageRole.USER, content: '想找静安附近兼职' },
        { role: MessageRole.ASSISTANT, content: '我帮你看看岗位' },
      ];

      expect(
        resolveHistoryForAgent({
          history,
          message: '我想找浦东附近兼职',
        }),
      ).toBe(history);
    });

    it('should keep empty history unchanged', () => {
      expect(
        resolveHistoryForAgent({
          history: [],
          message: '你好',
        }),
      ).toEqual([]);
    });
  });

  // ========== getExecution ==========

  describe('getExecution', () => {
    it('should return execution by id', async () => {
      const mockExecution = { id: 'exec-1', actual_output: 'hello' } as any;
      mockExecutionRepository.findById.mockResolvedValue(mockExecution);

      const result = await service.getExecution('exec-1');

      expect(executionRepository.findById).toHaveBeenCalledWith('exec-1');
      expect(result).toBe(mockExecution);
    });

    it('should return null when execution not found', async () => {
      mockExecutionRepository.findById.mockResolvedValue(null);

      const result = await service.getExecution('non-existent');

      expect(result).toBeNull();
    });
  });

  // ========== getExecutions ==========

  describe('getExecutions', () => {
    it('should return list of executions with default pagination', async () => {
      const mockList = [{ id: 'exec-1' }, { id: 'exec-2' }] as any;
      mockExecutionRepository.findMany.mockResolvedValue(mockList);

      const result = await service.getExecutions();

      expect(executionRepository.findMany).toHaveBeenCalledWith(50, 0);
      expect(result).toBe(mockList);
    });

    it('should pass custom limit and offset to repository', async () => {
      mockExecutionRepository.findMany.mockResolvedValue([]);

      await service.getExecutions(10, 20);

      expect(executionRepository.findMany).toHaveBeenCalledWith(10, 20);
    });
  });

  // ========== updateExecutionByBatchAndCase ==========

  describe('updateExecutionByBatchAndCase', () => {
    it('should call repository with correct parameters', async () => {
      mockExecutionRepository.updateByBatchAndCase.mockResolvedValue(undefined);

      await service.updateExecutionByBatchAndCase('batch-1', 'case-1', {
        executionStatus: ExecutionStatus.SUCCESS,
        durationMs: 1500,
        actualOutput: 'response text',
      });

      expect(executionRepository.updateByBatchAndCase).toHaveBeenCalledWith(
        'batch-1',
        'case-1',
        expect.objectContaining({
          executionStatus: ExecutionStatus.SUCCESS,
          durationMs: 1500,
        }),
      );
    });

    it('should re-throw repository errors', async () => {
      mockExecutionRepository.updateByBatchAndCase.mockRejectedValue(
        new Error('Database connection failed'),
      );

      await expect(
        service.updateExecutionByBatchAndCase('batch-1', 'case-1', {
          executionStatus: ExecutionStatus.FAILURE,
          durationMs: 500,
        }),
      ).rejects.toThrow('Database connection failed');
    });
  });

  // ========== countCompletedExecutions ==========

  describe('countCompletedExecutions', () => {
    it('should return execution counts grouped by status', async () => {
      const counts = { total: 10, success: 7, failure: 2, timeout: 1 };
      mockExecutionRepository.countCompletedByBatchId.mockResolvedValue(counts);

      const result = await service.countCompletedExecutions('batch-1');

      expect(executionRepository.countCompletedByBatchId).toHaveBeenCalledWith('batch-1');
      expect(result).toEqual(counts);
    });
  });

  // ========== saveExecution ==========

  describe('saveExecution', () => {
    it('should create execution record via repository', async () => {
      const mockExecution = { id: 'new-exec-1' } as any;
      mockExecutionRepository.create.mockResolvedValue(mockExecution);

      const result = await service.saveExecution({
        batchId: 'batch-1',
        caseId: 'case-1',
        caseName: 'Test Case',
        testInput: { message: 'test', history: [], scenario: 'test' },
        agentRequest: null,
        agentResponse: null,
        actualOutput: 'output',
        toolCalls: [],
        executionStatus: ExecutionStatus.SUCCESS,
        durationMs: 1000,
        tokenUsage: null,
        errorMessage: null,
      });

      expect(executionRepository.create).toHaveBeenCalled();
      expect(result).toBe(mockExecution);
    });
  });
});
