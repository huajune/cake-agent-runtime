import { TestSuiteQueueService } from '@biz/test-suite/services/test-suite-queue.service';
import { BatchStatus } from '@biz/test-suite/enums/test.enum';

describe('TestSuiteQueueService', () => {
  const processor = {
    getBatchProgress: jest.fn(),
    cancelBatchJobs: jest.fn(),
    getQueueStatus: jest.fn(),
    cleanFailedJobs: jest.fn(),
  };
  const batchService = {
    updateBatchStatus: jest.fn(),
  };
  const service = new TestSuiteQueueService(processor as any, batchService as any);

  beforeEach(() => {
    jest.clearAllMocks();
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
