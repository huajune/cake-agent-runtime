import { Injectable } from '@nestjs/common';
import { BatchStatus } from '../enums/test.enum';
import { TestSuiteProcessor } from '../test-suite.processor';
import { TestBatchService } from './test-batch.service';

@Injectable()
export class TestSuiteQueueService {
  constructor(
    private readonly testProcessor: TestSuiteProcessor,
    private readonly batchService: TestBatchService,
  ) {}

  async getBatchProgress(batchId: string) {
    return { success: true, data: await this.testProcessor.getBatchProgress(batchId) };
  }

  async cancelBatch(batchId: string) {
    const cancelled = await this.testProcessor.cancelBatchJobs(batchId);
    await this.batchService.updateBatchStatus(batchId, BatchStatus.CANCELLED);
    const totalCancelled = cancelled.waiting + cancelled.delayed + cancelled.active;

    return {
      success: true,
      data: {
        batchId,
        cancelled,
        totalCancelled,
        message: `已取消 ${totalCancelled} 个任务（等待=${cancelled.waiting}, 延迟=${cancelled.delayed}, 执行中=${cancelled.active}）`,
      },
    };
  }

  async getQueueStatus() {
    return { success: true, data: await this.testProcessor.getQueueStatus() };
  }

  async cleanFailedJobs() {
    const removedCount = await this.testProcessor.cleanFailedJobs();
    return {
      success: true,
      data: { removedCount, message: `已清理 ${removedCount} 个失败任务` },
    };
  }
}
