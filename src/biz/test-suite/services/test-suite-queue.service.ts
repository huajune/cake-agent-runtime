import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { BatchSource, BatchStatus, ExecutionStatus } from '../enums/test.enum';
import { TestSuiteProcessor } from '../test-suite.processor';
import { TestBatchService } from './test-batch.service';

import { TestExecutionService } from './test-execution.service';
import { SubmitBatchTestRequestDto } from '../dto/test-chat.dto';

@Injectable()
export class TestSuiteQueueService {
  constructor(
    private readonly testProcessor: TestSuiteProcessor,
    private readonly batchService: TestBatchService,
    private readonly executionService: TestExecutionService,
  ) {}

  async submitBatch(request: SubmitBatchTestRequestDto) {
    if (!request.cases.length || request.cases.length > 100) {
      throw new BadRequestException('批次须包含 1–100 条独立用例');
    }
    const cases = request.cases.map((testCase) => ({
      ...testCase,
      caseId: testCase.caseId || randomUUID(),
      caseName: testCase.caseName || '未命名',
    }));
    if (new Set(cases.map((testCase) => testCase.caseId)).size !== cases.length) {
      throw new BadRequestException('同一批次的 caseId 不得重复');
    }
    for (const field of ['userId', 'sessionId'] as const) {
      const identities = cases.map((testCase) => testCase[field]).filter(Boolean);
      if (new Set(identities).size !== identities.length) {
        throw new BadRequestException(`并行用例的 ${field} 不得重复`);
      }
    }
    const batch = await this.batchService.createBatch({
      name: request.batchName || `API 测试 ${new Date().toISOString()}`,
      source: BatchSource.MANUAL,
    });
    try {
      for (let offset = 0; offset < cases.length; offset += 10) {
        const writes = await Promise.allSettled(
          cases.slice(offset, offset + 10).map((testCase) =>
            this.executionService.saveExecution({
              batchId: batch.id,
              caseId: testCase.caseId,
              caseName: testCase.caseName,
              category: testCase.category,
              testInput: { ...testCase, batchId: batch.id },
              expectedOutput: testCase.expectedOutput,
              agentRequest: null,
              agentResponse: null,
              actualOutput: '',
              toolCalls: [],
              executionStatus: ExecutionStatus.PENDING,
              durationMs: 0,
              tokenUsage: null,
              errorMessage: null,
              sourceTrace: testCase.sourceTrace,
              memorySetup: testCase.memorySetup,
              memoryAssertions: testCase.memoryAssertions,
            }),
          ),
        );
        const failed = writes.find((write) => write.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      await this.batchService.updateBatchStats(batch.id);
      await this.testProcessor.addPreparedBatchJobs(batch.id, cases);
      // Workers wait for this admission barrier before touching Agent state.
      await this.batchService.updateBatchStatus(batch.id, BatchStatus.RUNNING);
    } catch (error) {
      await this.batchService.updateBatchStatus(batch.id, BatchStatus.CANCELLED);
      throw error;
    }
    return { batchId: batch.id, totalCases: cases.length };
  }

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
