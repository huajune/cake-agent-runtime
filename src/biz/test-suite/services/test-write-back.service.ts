import { Injectable, Logger } from '@nestjs/common';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import {
  testSuiteFieldNames,
  validationSetFieldNames,
} from '@infra/feishu/constants/feishu-bitable.config';
import { TestExecutionService } from './test-execution.service';
import { FeishuTestStatus } from '../enums/test.enum';

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
  private readonly fieldResolutionCache = new Map<string, Record<string, string | undefined>>();
  private readonly updateRetryDelaysMs = [300, 900];

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
    reviewSummary?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const execution = await this.executionService.getExecution(executionId);
    if (!execution) {
      return { success: false, error: '执行记录不存在' };
    }

    const recordId = execution.case_id;
    if (!recordId) {
      return { success: false, error: '执行记录缺少飞书记录 ID' };
    }

    return this.writeBackResult(
      recordId,
      testStatus,
      execution.batch_id || undefined,
      errorReason,
      reviewSummary,
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
      reviewSummary?: string;
    }>,
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    const writeBackItems: Array<{
      recordId: string;
      testStatus: FeishuTestStatus;
      batchId?: string;
      errorReason?: string;
      reviewSummary?: string;
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
        reviewSummary: item.reviewSummary,
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
    reviewSummary?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { appToken, tableId } = this.bitableApi.getTableConfig('testSuite');
      const resolvedFields = await this.resolveFieldNames(
        'testSuite',
        testSuiteFieldNames as Record<keyof typeof testSuiteFieldNames, string[] | undefined>,
      );

      const updateFields: Record<string, unknown> = {};

      this.logger.debug(`回写飞书: 记录=${recordId}, 状态=${testStatus}, 批次=${batchId}`);

      if (resolvedFields.testStatus) {
        updateFields[resolvedFields.testStatus] = testStatus;
      }
      if (resolvedFields.lastTestTime) {
        updateFields[resolvedFields.lastTestTime] = Date.now();
      }

      if (batchId && resolvedFields.testBatch) {
        updateFields[resolvedFields.testBatch] = batchId;
      }

      if (testStatus === FeishuTestStatus.FAILED && errorReason && resolvedFields.errorReason) {
        updateFields[resolvedFields.errorReason] = errorReason;
      }
      if (reviewSummary && resolvedFields.reviewSummary) {
        updateFields[resolvedFields.reviewSummary] = reviewSummary;
      }

      if (Object.keys(updateFields).length === 0) {
        return { success: false, error: 'testSuite 未找到可回写字段' };
      }

      this.logger.debug(`更新字段: ${JSON.stringify(updateFields)}`);
      const result = await this.updateRecordWithRetry(appToken, tableId, recordId, updateFields);

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
      reviewSummary?: string;
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
        item.reviewSummary,
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
   */
  async writeBackSimilarityScore(
    recordId: string,
    avgSimilarityScore: number | null,
    options?: {
      batchId?: string;
      testStatus?: FeishuTestStatus;
      minSimilarityScore?: number | null;
      evaluationSummary?: string | null;
      dimensionScores?: {
        factualAccuracy: number | null;
        responseEfficiency: number | null;
        processCompliance: number | null;
        toneNaturalness: number | null;
      };
    },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { appToken, tableId } = this.bitableApi.getTableConfig('validationSet');
      const resolvedFields = await this.resolveFieldNames(
        'validationSet',
        validationSetFieldNames as Record<
          keyof typeof validationSetFieldNames,
          string[] | undefined
        >,
      );

      const updateFields: Record<string, unknown> = {};

      this.logger.debug(`回写相似度分数: 记录=${recordId}, 分数=${avgSimilarityScore}`);

      if (avgSimilarityScore !== null && resolvedFields.similarityScore) {
        updateFields[resolvedFields.similarityScore] = avgSimilarityScore;
      }

      if (options?.minSimilarityScore !== undefined && resolvedFields.minSimilarityScore) {
        updateFields[resolvedFields.minSimilarityScore] = options.minSimilarityScore;
      }

      if (options?.evaluationSummary && resolvedFields.evaluationSummary) {
        updateFields[resolvedFields.evaluationSummary] = options.evaluationSummary;
      }

      if (
        options?.dimensionScores?.factualAccuracy !== null &&
        options?.dimensionScores?.factualAccuracy !== undefined &&
        resolvedFields.factualAccuracy
      ) {
        updateFields[resolvedFields.factualAccuracy] = options.dimensionScores.factualAccuracy;
      }

      if (
        options?.dimensionScores?.responseEfficiency !== null &&
        options?.dimensionScores?.responseEfficiency !== undefined &&
        resolvedFields.responseEfficiency
      ) {
        updateFields[resolvedFields.responseEfficiency] =
          options.dimensionScores.responseEfficiency;
      }

      if (
        options?.dimensionScores?.processCompliance !== null &&
        options?.dimensionScores?.processCompliance !== undefined &&
        resolvedFields.processCompliance
      ) {
        updateFields[resolvedFields.processCompliance] = options.dimensionScores.processCompliance;
      }

      if (
        options?.dimensionScores?.toneNaturalness !== null &&
        options?.dimensionScores?.toneNaturalness !== undefined &&
        resolvedFields.toneNaturalness
      ) {
        updateFields[resolvedFields.toneNaturalness] = options.dimensionScores.toneNaturalness;
      }

      if (resolvedFields.lastTestTime) {
        updateFields[resolvedFields.lastTestTime] = Date.now();
      }

      if (options?.batchId && resolvedFields.testBatch) {
        updateFields[resolvedFields.testBatch] = options.batchId;
      }

      const testStatus =
        options?.testStatus ??
        (avgSimilarityScore === null
          ? undefined
          : avgSimilarityScore >= 60
            ? FeishuTestStatus.PASSED
            : FeishuTestStatus.FAILED);

      if (testStatus && resolvedFields.testStatus) {
        updateFields[resolvedFields.testStatus] = testStatus;
      }

      if (Object.keys(updateFields).length === 0) {
        return { success: false, error: 'validationSet 未找到可回写字段' };
      }

      this.logger.debug(`更新字段: ${JSON.stringify(updateFields)}`);
      const result = await this.updateRecordWithRetry(appToken, tableId, recordId, updateFields);

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

  private async resolveFieldNames<T extends Record<string, string[] | undefined>>(
    tableName: 'testSuite' | 'validationSet',
    aliases: T,
  ): Promise<Record<keyof T, string | undefined>> {
    const cacheKey = `${tableName}:${JSON.stringify(aliases)}`;
    const cached = this.fieldResolutionCache.get(cacheKey);
    if (cached) {
      return cached as Record<keyof T, string | undefined>;
    }

    const { appToken, tableId } = this.bitableApi.getTableConfig(tableName);
    const fields = await this.bitableApi.getFields(appToken, tableId);
    const availableNames = new Set(fields.map((field) => field.field_name));

    const resolved = {} as Record<keyof T, string | undefined>;
    for (const key of Object.keys(aliases) as Array<keyof T>) {
      const candidates = aliases[key] || [];
      resolved[key] = candidates.find((candidate) => availableNames.has(candidate));
      if (!resolved[key]) {
        this.logger.warn(
          `[${tableName}] 未找到字段别名: ${String(key)} (${candidates.join(', ') || '无'})`,
        );
      }
    }

    this.fieldResolutionCache.set(cacheKey, resolved as Record<string, string | undefined>);
    return resolved;
  }

  private async updateRecordWithRetry(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string }> {
    let lastError: string | undefined;
    const attempts = this.updateRetryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await this.bitableApi.updateRecord(appToken, tableId, recordId, fields);
        if (result.success) {
          return result;
        }

        lastError = result.error;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < attempts) {
        this.logger.warn(`回写飞书失败，准备重试(${attempt}/${attempts}): ${lastError}`);
        await this.sleep(this.updateRetryDelaysMs[attempt - 1]);
      }
    }

    return { success: false, error: lastError };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
