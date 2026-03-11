import { Injectable, Logger } from '@nestjs/common';
import { TestExecutionService } from './test-execution.service';
import { FeishuTestSyncService } from './feishu-test-sync.service';
import { FeishuTestStatus } from '../enums';

/**
 * 测试结果回写服务
 *
 * 职责：
 * - 单条回写测试结果到飞书
 * - 批量回写测试结果到飞书
 */
@Injectable()
export class TestWriteBackService {
  private readonly logger = new Logger(TestWriteBackService.name);

  constructor(
    private readonly executionService: TestExecutionService,
    private readonly feishuSyncService: FeishuTestSyncService,
  ) {
    this.logger.log('TestWriteBackService 初始化完成');
  }

  /**
   * 回写测试结果到飞书测试/验证集表
   */
  async writeBackToFeishu(
    executionId: string,
    testStatus: FeishuTestStatus,
    errorReason?: string,
  ): Promise<{ success: boolean; error?: string }> {
    // 1. 获取执行记录
    const execution = await this.executionService.getExecution(executionId);
    if (!execution) {
      return { success: false, error: '执行记录不存在' };
    }

    // case_id 是飞书记录的 record_id
    const recordId = execution.case_id;
    if (!recordId) {
      return { success: false, error: '执行记录缺少飞书记录 ID' };
    }

    // 2. 使用 FeishuTestSyncService 回写结果
    return this.feishuSyncService.writeBackResult(
      recordId,
      testStatus,
      execution.batch_id || undefined,
      errorReason,
    );
  }

  /**
   * 批量回写测试结果到飞书
   */
  async batchWriteBackToFeishu(
    items: Array<{
      executionId: string;
      testStatus: FeishuTestStatus;
      errorReason?: string;
    }>,
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    // 先获取所有执行记录的 recordId
    const writeBackItems: Array<{
      recordId: string;
      testStatus: FeishuTestStatus;
      batchId?: string;
      errorReason?: string;
    }> = [];

    const errors: string[] = [];

    for (const item of items) {
      const execution = await this.executionService.getExecution(item.executionId);
      if (!execution) {
        errors.push(`${item.executionId}: 执行记录不存在`);
        continue;
      }
      if (!execution.case_id) {
        errors.push(`${item.executionId}: 执行记录缺少飞书记录 ID`);
        continue;
      }

      writeBackItems.push({
        recordId: execution.case_id,
        testStatus: item.testStatus,
        batchId: execution.batch_id || undefined,
        errorReason: item.errorReason,
      });
    }

    // 使用 FeishuTestSyncService 批量回写
    const result = await this.feishuSyncService.batchWriteBackResults(writeBackItems);

    return {
      success: result.success,
      failed: result.failed + errors.length,
      errors: [...errors, ...result.errors],
    };
  }
}
