import type { Job } from 'bull';
import {
  TestSuiteProcessor,
  type TestJobData,
  type TestJobResult,
} from '@biz/test-suite/test-suite.processor';
import { ExecutionStatus } from '@biz/test-suite/enums/test.enum';

describe('TestSuiteProcessor tool constraints', () => {
  const queue = {
    add: jest.fn(),
  };
  const batchService = {};
  const executionService = {
    executeTest: jest.fn(),
    updateExecutionByBatchAndCase: jest.fn(),
  };
  const redisService = {
    setex: jest.fn(),
  };
  const configService = {
    get: jest.fn(),
  };

  const buildProcessor = () =>
    new TestSuiteProcessor(
      queue as never,
      batchService as never,
      executionService as never,
      redisService as never,
      configService as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    queue.add.mockResolvedValue({ id: 'job-1' });
    executionService.executeTest.mockResolvedValue({
      executionId: 'execution-1',
      status: ExecutionStatus.SUCCESS,
      request: { body: {} },
      response: { body: {}, toolCalls: [] },
      actualOutput: 'ok',
      metrics: {
        durationMs: 12,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    });
    executionService.updateExecutionByBatchAndCase.mockResolvedValue(undefined);
    redisService.setex.mockResolvedValue(undefined);
  });

  it('preserves toolMode and an empty allowlist when enqueuing batch cases', async () => {
    await buildProcessor().addBatchTestJobs('batch-1', [
      {
        caseId: 'case-1',
        caseName: 'readonly without tools',
        message: '测试消息',
        toolMode: 'readonly',
        allowedToolNames: [],
      },
    ]);

    expect(queue.add).toHaveBeenCalledWith(
      'execute-test',
      expect.objectContaining({
        toolMode: 'readonly',
        allowedToolNames: [],
      }),
      expect.any(Object),
    );
  });

  it('passes queued constraints to execution without collapsing an empty allowlist', async () => {
    const data: TestJobData = {
      batchId: 'batch-1',
      caseId: 'case-1',
      caseName: 'readonly without tools',
      message: '测试消息',
      toolMode: 'readonly',
      allowedToolNames: [],
      totalCases: 1,
      caseIndex: 0,
    };
    const job = {
      data,
      progress: jest.fn().mockResolvedValue(undefined),
    } as unknown as Job<TestJobData>;

    await (
      buildProcessor() as unknown as {
        handleTestJob(job: Job<TestJobData>): Promise<TestJobResult>;
      }
    ).handleTestJob(job);

    expect(executionService.executeTest).toHaveBeenCalledWith(
      expect.objectContaining({
        toolMode: 'readonly',
        allowedToolNames: [],
      }),
    );
  });

  it('keeps omitted constraints undefined so downstream defaults to scenario mode', async () => {
    const data: TestJobData = {
      batchId: 'batch-1',
      caseId: 'case-default',
      caseName: 'default scenario',
      message: '测试消息',
      totalCases: 1,
      caseIndex: 0,
    };
    const job = {
      data,
      progress: jest.fn().mockResolvedValue(undefined),
    } as unknown as Job<TestJobData>;

    await (
      buildProcessor() as unknown as {
        handleTestJob(job: Job<TestJobData>): Promise<TestJobResult>;
      }
    ).handleTestJob(job);

    expect(executionService.executeTest).toHaveBeenCalledWith(
      expect.objectContaining({
        toolMode: undefined,
        allowedToolNames: undefined,
      }),
    );
  });
});
