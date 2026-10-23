import BullQueue = require('bull');
jest.mock('bull', () => jest.fn());
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
    name: 'test-suite',
    client: { duplicate: jest.fn(() => ({ quit: jest.fn().mockResolvedValue(undefined) })) },
    process: jest.fn(),
    on: jest.fn(),
  };
  const batchService = { getBatch: jest.fn() };
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
    configService.get.mockReset();
    batchService.getBatch.mockResolvedValue({ status: 'running' });
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

  it('allocates one blocking worker per Upstash concurrency slot and closes them', async () => {
    const workers = Array.from({ length: 3 }, () => ({
      process: jest.fn(),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    }));
    const constructor = BullQueue as unknown as jest.Mock;
    workers.forEach((worker) => constructor.mockImplementationOnce(() => worker));
    configService.get.mockImplementation((key) =>
      key === 'UPSTASH_REDIS_TCP_URL'
        ? 'rediss://test'
        : key === 'TEST_SUITE_WORKER_CONCURRENCY'
          ? 3
          : undefined,
    );
    const processor = buildProcessor();
    (processor as unknown as { registerWorkers(): void }).registerWorkers();
    expect(constructor).toHaveBeenCalledTimes(3);
    for (const worker of workers)
      expect(worker.process).toHaveBeenCalledWith('execute-test', 1, expect.any(Function));
    expect(queue.process).not.toHaveBeenCalled();
    await processor.onModuleDestroy();
    workers.forEach((worker) => expect(worker.close).toHaveBeenCalledTimes(1));
  });

  it('keeps the entire async request and isolates the generated batch ID', async () => {
    const request = {
      caseId: 'c',
      caseName: 'n',
      userId: 'u',
      sessionId: 's',
      scenario: 'custom',
      botUserId: 'bot',
      botImId: 'im',
      modelId: 'provider/model',
      imageUrls: ['image'],
      allowedToolNames: [],
      batchId: 'untrusted',
    };

    await buildProcessor().addPreparedBatchJobs('batch-1', [request]);
    const data = queue.add.mock.calls[0][1];
    expect(data).toMatchObject({ batchId: 'batch-1', request });
    await (
      buildProcessor() as unknown as {
        handleTestJob(job: Job<TestJobData>): Promise<TestJobResult>;
      }
    ).handleTestJob({ data, progress: jest.fn() } as unknown as Job<TestJobData>);
    expect(executionService.executeTest).toHaveBeenCalledWith(
      expect.objectContaining({ ...request, batchId: 'batch-1', saveExecution: false }),
    );
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
