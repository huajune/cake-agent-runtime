import { TestSuiteQueueService } from '@biz/test-suite/services/test-suite-queue.service';
import { BatchStatus } from '@biz/test-suite/enums/test.enum';

describe('TestSuiteQueueService', () => {
  const processor = {
    getBatchProgress: jest.fn(),
    addPreparedBatchJobs: jest.fn(),
    cancelBatchJobs: jest.fn(),
    getQueueStatus: jest.fn(),
    cleanFailedJobs: jest.fn(),
  };
  const batchService = {
    updateBatchStatus: jest.fn(),
    createBatch: jest.fn(),
    updateBatchStats: jest.fn(),
  };
  const executionService = { saveExecution: jest.fn() };
  const service = new TestSuiteQueueService(
    processor as never,
    batchService as never,
    executionService as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    batchService.createBatch.mockResolvedValue({ id: 'batch-1' });
  });

  it('persists pending records before admitting jobs and returns without executing the Agent', async () => {
    const testCase = {
      message: 'test',
      userId: 'u',
      sessionId: 's',
      modelId: 'provider/model',
      imageUrls: ['https://example.com/image'],
      toolMode: 'none' as const,
    };
    await expect(service.submitBatch({ cases: [testCase] })).resolves.toEqual({
      batchId: 'batch-1',
      totalCases: 1,
    });
    expect(executionService.saveExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        testInput: expect.objectContaining(testCase),
        executionStatus: 'pending',
      }),
    );
    expect(processor.addPreparedBatchJobs).toHaveBeenCalledWith('batch-1', [
      expect.objectContaining(testCase),
    ]);
    expect(executionService.saveExecution.mock.invocationCallOrder[0]).toBeLessThan(
      processor.addPreparedBatchJobs.mock.invocationCallOrder[0],
    );
  });

  it('rejects duplicate IDs before creating a batch', async () => {
    await expect(
      service.submitBatch({ cases: [{ caseId: 'same' }, { caseId: 'same' }] }),
    ).rejects.toThrow('caseId');
    expect(batchService.createBatch).not.toHaveBeenCalled();
  });

  it.each(['userId', 'sessionId'])(
    'rejects shared %s before creating a parallel batch',
    async (field) => {
      await expect(
        service.submitBatch({
          cases: [
            { caseId: 'a', [field]: 'shared' },
            { caseId: 'b', [field]: 'shared' },
          ],
        }),
      ).rejects.toThrow(field);
      expect(batchService.createBatch).not.toHaveBeenCalled();
    },
  );

  it('opens the execution barrier only after every enqueue succeeds', async () => {
    processor.addPreparedBatchJobs.mockImplementation(async () => {
      expect(batchService.updateBatchStatus).not.toHaveBeenCalledWith(
        'batch-1',
        BatchStatus.RUNNING,
      );
    });
    await service.submitBatch({ cases: [{ message: 'test' }] });
    expect(batchService.updateBatchStatus).toHaveBeenLastCalledWith('batch-1', BatchStatus.RUNNING);
  });

  it('does not admit jobs when persistence fails', async () => {
    executionService.saveExecution.mockRejectedValue(new Error('database unavailable'));
    await expect(service.submitBatch({ cases: [{ message: 'test' }] })).rejects.toThrow(
      'database unavailable',
    );
    expect(processor.addPreparedBatchJobs).not.toHaveBeenCalled();
    expect(batchService.updateBatchStatus).toHaveBeenLastCalledWith(
      'batch-1',
      BatchStatus.CANCELLED,
    );
  });

  it('reports enqueue failure instead of acknowledging a lost batch', async () => {
    processor.addPreparedBatchJobs.mockRejectedValue(new Error('queue unavailable'));
    await expect(service.submitBatch({ cases: [{ message: 'test' }] })).rejects.toThrow(
      'queue unavailable',
    );
    expect(batchService.updateBatchStatus).toHaveBeenLastCalledWith(
      'batch-1',
      BatchStatus.CANCELLED,
    );
  });

  it('wraps batch progress from the processor', async () => {
    processor.getBatchProgress.mockResolvedValue({ completed: 2, total: 5 });

    await expect(service.getBatchProgress('batch-1')).resolves.toEqual({
      success: true,
      data: { completed: 2, total: 5 },
    });
    expect(processor.getBatchProgress).toHaveBeenCalledWith('batch-1');
  });

  it('cancels queued jobs and marks the batch cancelled', async () => {
    processor.cancelBatchJobs.mockResolvedValue({ waiting: 1, delayed: 2, active: 3 });

    await expect(service.cancelBatch('batch-1')).resolves.toMatchObject({
      success: true,
      data: {
        batchId: 'batch-1',
        totalCancelled: 6,
        message: '已取消 6 个任务（等待=1, 延迟=2, 执行中=3）',
      },
    });
    expect(batchService.updateBatchStatus).toHaveBeenCalledWith('batch-1', BatchStatus.CANCELLED);
  });

  it('wraps queue status and clean failed jobs responses', async () => {
    processor.getQueueStatus.mockResolvedValue({ waiting: 1 });
    processor.cleanFailedJobs.mockResolvedValue(4);

    await expect(service.getQueueStatus()).resolves.toEqual({
      success: true,
      data: { waiting: 1 },
    });
    await expect(service.cleanFailedJobs()).resolves.toEqual({
      success: true,
      data: { removedCount: 4, message: '已清理 4 个失败任务' },
    });
  });
});
