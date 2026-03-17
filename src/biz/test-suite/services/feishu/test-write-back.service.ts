import { Injectable, Logger } from '@nestjs/common';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import {
  testSuiteFieldNames,
  validationSetFieldNames,
} from '@infra/feishu/constants/feishu-bitable.config';
import { TestExecutionService } from '../execution/test-execution.service';
import { FeishuTestStatus } from '../../enums/test.enum';

/**
 * 测试结果回写服务
 *
 * 职责：
 * - 单条回写测试结果到飞书（通过执行记录 ID 查找飞书 record ID）
 * - 批量回写测试结果到飞书
 * - 直接回写飞书记录（按 record ID）
 * - 回写回归验证相似度分数
 */
@Injectable()
export class TestWriteBackService {
  private readonly logger = new Logger(TestWriteBackService.name);

  constructor(
    private readonly executionService: TestExecutionService,
    private readonly bitableApi: FeishuBitableApiService,
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

    return this.writeBackResult(recordId, testStatus, execution.batch_id || undefined, errorReason);
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

    const result = await this.batchWriteBackResults(writeBackItems);

    return {
      success: result.success,
      failed: result.failed + errors.length,
      errors: [...errors, ...result.errors],
    };
  }

  /**
   * 回写测试结果到飞书记录（按 record ID）
   */
  async writeBackResult(
    recordId: string,
    testStatus: FeishuTestStatus,
    batchId?: string,
    errorReason?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');

      // 构建更新数据（飞书 API 更新记录时需要使用字段名称，不是字段 ID）
      const updateFields: Record<string, unknown> = {};

      this.logger.debug(`回写飞书: 记录=${recordId}, 状态=${testStatus}, 批次=${batchId}`);

      // 1. 测试状态（单选字段）- 单选字段使用选项名称（不是选项 ID）
      updateFields[testSuiteFieldNames.testStatus] = testStatus;

      // 2. 最近测试时间（日期时间字段）
      updateFields[testSuiteFieldNames.lastTestTime] = Date.now();

      // 3. 测试批次（文本字段）
      if (batchId) {
        updateFields[testSuiteFieldNames.testBatch] = batchId;
      }

      // 4. 错误原因（单选字段）- Agent 错误归因，仅在失败时更新
      if (testStatus === FeishuTestStatus.FAILED && errorReason) {
        updateFields[testSuiteFieldNames.errorReason] = errorReason;
      }

      this.logger.debug(`更新字段: ${JSON.stringify(updateFields)}`);
      const result = await this.bitableApi.updateRecord(appToken, tableId, recordId, updateFields);

      if (!result.success) {
        this.logger.error(`回写飞书失败: ${result.error}`);
        return { success: false, error: result.error };
      }

      this.logger.log(`回写飞书成功: ${recordId} -> ${testStatus}`);
      return { success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`回写飞书异常: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * 批量回写测试结果（按 record ID 列表）
   */
  async batchWriteBackResults(
    items: Array<{
      recordId: string;
      testStatus: FeishuTestStatus;
      batchId?: string;
      errorReason?: string;
    }>,
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const item of items) {
      const result = await this.writeBackResult(
        item.recordId,
        item.testStatus,
        item.batchId,
        item.errorReason,
      );

      if (result.success) {
        success++;
      } else {
        failed++;
        errors.push(`${item.recordId}: ${result.error}`);
      }
    }

    return { success, failed, errors };
  }

  /**
   * 回写回归验证相似度分数到飞书
   *
   * 注意：回归验证数据现在写入 validationSet 表（已从 testSuite 迁移）
   */
  async writeBackSimilarityScore(
    recordId: string,
    avgSimilarityScore: number | null,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 回归验证使用独立的验证集表
      const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');

      const updateFields: Record<string, unknown> = {};

      this.logger.debug(`回写相似度分数: 记录=${recordId}, 分数=${avgSimilarityScore}`);

      // 相似度分数字段（数字字段）- 使用验证集字段名配置
      if (avgSimilarityScore !== null) {
        updateFields[validationSetFieldNames.similarityScore] = avgSimilarityScore;
      }

      // 更新最近测试时间 - 使用验证集字段名配置
      updateFields[validationSetFieldNames.lastTestTime] = Date.now();

      this.logger.debug(`更新字段: ${JSON.stringify(updateFields)}`);
      const result = await this.bitableApi.updateRecord(appToken, tableId, recordId, updateFields);

      if (!result.success) {
        this.logger.error(`回写相似度分数失败: ${result.error}`);
        return { success: false, error: result.error };
      }

      this.logger.log(`回写相似度分数成功: ${recordId} -> ${avgSimilarityScore}`);
      return { success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`回写相似度分数异常: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }
}
