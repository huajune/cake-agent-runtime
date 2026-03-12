import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TestExecutionService } from './test-execution.service';
import { TestExecutionRepository } from '../../repositories/test-execution.repository';
import { AgentFacadeService, AgentResultStatus } from '@agent';
import { ExecutionStatus } from '../../enums/test.enum';
import { TestChatRequestDto } from '../../dto/test-chat.dto';
import { MessageRole } from '@shared/enums';

describe('TestExecutionService', () => {
  let service: TestExecutionService;
  let agentFacade: jest.Mocked<AgentFacadeService>;
  let executionRepository: jest.Mocked<TestExecutionRepository>;
  let _configService: jest.Mocked<ConfigService>;

  const mockConfigService = {
    get: jest.fn().mockReturnValue('https://api.example.com'),
  };

  const mockAgentFacade = {
    chatWithScenario: jest.fn(),
    chatStreamWithScenario: jest.fn(),
  };

  const mockExecutionRepository = {
    findById: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateByBatchAndCase: jest.fn(),
    countCompletedByBatchId: jest.fn(),
  };

  const makeSuccessAgentResult = (text = 'Agent reply') => ({
    status: AgentResultStatus.SUCCESS,
    data: {
      messages: [{ parts: [{ text }] }],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    },
  });

  const makeErrorAgentResult = (message = 'Agent error') => ({
    status: AgentResultStatus.ERROR,
    error: { code: 'ERR', message },
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestExecutionService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AgentFacadeService, useValue: mockAgentFacade },
        { provide: TestExecutionRepository, useValue: mockExecutionRepository },
      ],
    }).compile();

    service = module.get<TestExecutionService>(TestExecutionService);
    agentFacade = module.get(AgentFacadeService);
    executionRepository = module.get(TestExecutionRepository);
    _configService = module.get(ConfigService);

    jest.clearAllMocks();
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
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeSuccessAgentResult('AI回复'));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.SUCCESS);
      expect(result.actualOutput).toBe('AI回复');
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.response.statusCode).toBe(200);
    });

    it('should return FAILURE status when agent returns error', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeErrorAgentResult('Service error'));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.FAILURE);
      expect(result.response.statusCode).toBe(500);
    });

    it('should return TIMEOUT status when timeout error is thrown', async () => {
      mockAgentFacade.chatWithScenario.mockRejectedValue(new Error('Request timeout exceeded'));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.TIMEOUT);
    });

    it('should return FAILURE status for non-timeout errors', async () => {
      mockAgentFacade.chatWithScenario.mockRejectedValue(new Error('Network error'));

      const result = await service.executeTest(baseRequest);

      expect(result.status).toBe(ExecutionStatus.FAILURE);
    });

    it('should save execution record when saveExecution is true', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeSuccessAgentResult());
      mockExecutionRepository.create.mockResolvedValue({ id: 'exec-1' } as any);

      const request = { ...baseRequest, saveExecution: true, batchId: 'batch-1' };
      const result = await service.executeTest(request);

      expect(executionRepository.create).toHaveBeenCalledTimes(1);
      expect(result.executionId).toBe('exec-1');
    });

    it('should not save execution record when saveExecution is false', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeSuccessAgentResult());

      await service.executeTest({ ...baseRequest, saveExecution: false });

      expect(executionRepository.create).not.toHaveBeenCalled();
    });

    it('should save execution record by default when saveExecution is not set', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeSuccessAgentResult());
      mockExecutionRepository.create.mockResolvedValue({ id: 'exec-2' } as any);

      const request = { ...baseRequest };
      delete (request as Partial<TestChatRequestDto>).saveExecution;
      await service.executeTest(request);

      expect(executionRepository.create).toHaveBeenCalled();
    });

    it('should use default scenario when none is provided', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeSuccessAgentResult());

      const request = { ...baseRequest, scenario: undefined };
      await service.executeTest(request);

      expect(agentFacade.chatWithScenario).toHaveBeenCalledWith(
        'candidate-consultation',
        expect.any(String),
        baseRequest.message,
        expect.any(Object),
      );
    });

    it('should trim last 2 history entries before calling agent', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeSuccessAgentResult());

      const history = [
        { role: MessageRole.USER, content: 'h1' },
        { role: MessageRole.ASSISTANT, content: 'h2' },
        { role: MessageRole.USER, content: 'h3' },
        { role: MessageRole.ASSISTANT, content: 'h4' },
      ];
      await service.executeTest({ ...baseRequest, history });

      const callArgs = agentFacade.chatWithScenario.mock.calls[0];
      const options = callArgs[3] as { messages: unknown[] };
      expect(options.messages).toHaveLength(2); // sliced last 2
    });

    it('should include token usage in metrics', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue(makeSuccessAgentResult());

      const result = await service.executeTest(baseRequest);

      expect(result.metrics.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      });
    });

    it('should return zero token usage when agent has no data', async () => {
      mockAgentFacade.chatWithScenario.mockResolvedValue({
        status: AgentResultStatus.ERROR,
        error: { code: 'ERR', message: 'fail' },
      });

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
      const mockStream = { pipe: jest.fn() } as unknown as NodeJS.ReadableStream;
      mockAgentFacade.chatStreamWithScenario.mockResolvedValue({
        stream: mockStream,
        estimatedInputTokens: 100,
      });

      const result = await service.executeTestStream({
        message: 'hello',
        userId: 'user-1',
      });

      expect(result).toBe(mockStream);
    });
  });

  // ========== executeTestStreamWithMeta ==========

  describe('executeTestStreamWithMeta', () => {
    it('should return stream and estimatedInputTokens', async () => {
      const mockStream = {} as NodeJS.ReadableStream;
      mockAgentFacade.chatStreamWithScenario.mockResolvedValue({
        stream: mockStream,
        estimatedInputTokens: 250,
      });

      const result = await service.executeTestStreamWithMeta({
        message: 'hello',
        userId: 'user-1',
      });

      expect(result.stream).toBe(mockStream);
      expect(result.estimatedInputTokens).toBe(250);
    });

    it('should not trim history when skipHistoryTrim is true', async () => {
      const mockStream = {} as NodeJS.ReadableStream;
      mockAgentFacade.chatStreamWithScenario.mockResolvedValue({
        stream: mockStream,
        estimatedInputTokens: 100,
      });

      const history = [
        { role: MessageRole.USER, content: 'h1' },
        { role: MessageRole.ASSISTANT, content: 'h2' },
        { role: MessageRole.USER, content: 'h3' },
        { role: MessageRole.ASSISTANT, content: 'h4' },
      ];

      await service.executeTestStreamWithMeta({
        message: 'hello',
        userId: 'user-1',
        history,
        skipHistoryTrim: true,
      });

      const callArgs = agentFacade.chatStreamWithScenario.mock.calls[0];
      const options = callArgs[3] as { messages: unknown[] };
      expect(options.messages).toHaveLength(4); // all preserved
    });

    it('should trim last 2 history entries when skipHistoryTrim is false', async () => {
      const mockStream = {} as NodeJS.ReadableStream;
      mockAgentFacade.chatStreamWithScenario.mockResolvedValue({
        stream: mockStream,
        estimatedInputTokens: 100,
      });

      const history = [
        { role: MessageRole.USER, content: 'h1' },
        { role: MessageRole.ASSISTANT, content: 'h2' },
        { role: MessageRole.USER, content: 'h3' },
        { role: MessageRole.ASSISTANT, content: 'h4' },
      ];

      await service.executeTestStreamWithMeta({
        message: 'hello',
        userId: 'user-1',
        history,
        skipHistoryTrim: false,
      });

      const callArgs = agentFacade.chatStreamWithScenario.mock.calls[0];
      const options = callArgs[3] as { messages: unknown[] };
      expect(options.messages).toHaveLength(2); // sliced
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
