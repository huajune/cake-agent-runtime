import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { Queue, Job } from 'bull';
import { TestBatchService } from './services/test-batch.service';
import { TestExecutionService } from './services/test-execution.service';
import { TestBatch } from './entities/test-batch.entity';
import { RedisService } from '@infra/redis/redis.service';
import { ExecutionStatus, MessageRole, BatchStatus } from './enums/test.enum';
import type {
  MemoryAssertions,
  MemoryFixtureSetup,
  TestExecutionTraceBundle,
  TestMemoryTraceBundle,
  TestSourceTrace,
} from './types/test-debug-trace.types';

/**
 * 测试任务 Job 数据结构
 */
export interface TestJobData {
  batchId: string;
  caseId: string;
  caseName: string;
  category?: string;
  message: string;
  history?: Array<{ role: MessageRole; content: string }>;
  expectedOutput?: string;
  sourceTrace?: TestSourceTrace | null;
  memorySetup?: MemoryFixtureSetup | null;
  memoryAssertions?: MemoryAssertions | null;
  totalCases: number;
  caseIndex: number;
}

/**
 * 测试任务执行结果
 */
export interface TestJobResult {
  executionId: string;
  status: ExecutionStatus;
  durationMs: number;
  error?: string;
}

/**
 * 批次执行进度
 */
export interface BatchProgress {
  batchId: string;
  status: TestBatch['status'];
  totalCases: number;
  completedCases: number;
  successCount: number;
  failureCount: number;
  progress: number;
  estimatedRemainingMs?: number;
  avgDurationMs?: number;
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
  toolCallId?: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
}

/**
 * 执行记录更新数据
 */
export interface ExecutionRecordUpdate {
  request: { body: unknown };
  response: { body: unknown; toolCalls?: unknown[] };
  actualOutput: string;
  status: ExecutionStatus;
  metrics: { durationMs: number; tokenUsage: TokenUsage };
  trace?: {
    executionTrace?: TestExecutionTraceBundle | null;
    memoryTrace?: TestMemoryTraceBundle | null;
  };
}

/**
 * 测试套件任务队列处理器
 */
@Injectable()
export class TestSuiteProcessor implements OnModuleInit {
  private readonly logger = new Logger(TestSuiteProcessor.name);

  private readonly concurrency: number;
  private readonly jobTimeoutMs: number;

  private readonly PROGRESS_CACHE_PREFIX = 'test-suite:progress:';
  private readonly PROGRESS_CACHE_TTL = 3600;

  constructor(
    @InjectQueue('test-suite') private readonly testQueue: Queue<TestJobData>,
    private readonly batchService: TestBatchService,
    private readonly executionService: TestExecutionService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.concurrency = this.readPositiveInt('TEST_SUITE_WORKER_CONCURRENCY', 20, {
      min: 1,
      max: 20,
    });
    this.jobTimeoutMs = this.readPositiveInt('TEST_SUITE_JOB_TIMEOUT_MS', 180_000, {
      min: 10_000,
      max: 600_000,
    });
  }

  async onModuleInit() {
    await this.waitForQueueReady();
    this.registerWorkers();
    this.setupQueueEventListeners();

    this.logger.log(
      `TestSuiteProcessor 已初始化（并发数: ${this.concurrency}, 超时: ${this.jobTimeoutMs}ms）`,
    );
  }

  private async waitForQueueReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.testQueue.client?.status === 'ready') {
        this.logger.log('[TestSuite Queue] 已就绪');
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('等待 TestSuite Queue 就绪超时'));
      }, 30000);

      this.testQueue.on('ready', () => {
        clearTimeout(timeout);
        this.logger.log('[TestSuite Queue] 已就绪');
        resolve();
      });

      this.testQueue.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error('[TestSuite Queue] 连接错误:', error);
        reject(error);
      });
    });
  }

  private registerWorkers(): void {
    this.logger.log(`[TestSuite] 注册 Worker，并发数: ${this.concurrency}...`);

    this.testQueue.process('execute-test', this.concurrency, async (job: Job<TestJobData>) => {
      return this.handleTestJob(job);
    });

    this.logger.log('[TestSuite] ✅ Worker 已注册');
  }

  private setupQueueEventListeners(): void {
    this.testQueue.on('completed', (job: Job<TestJobData>, result: TestJobResult) => {
      this.onJobCompleted(job, result);
    });

    this.testQueue.on('failed', (job: Job<TestJobData>, error: Error) => {
      this.onJobFailed(job, error);
    });

    this.testQueue.on('active', (job: Job<TestJobData>) => {
      this.logger.log(`[TestSuite] 🔄 任务 ${job.id} 开始: ${job.data.caseName}`);
    });

    this.testQueue.on('stalled', (job: Job<TestJobData>) => {
      this.logger.warn(`[TestSuite] ⚠️ 任务 ${job.id} 卡住: ${job.data.caseName}`);
    });
  }

  private async handleTestJob(job: Job<TestJobData>): Promise<TestJobResult> {
    const {
      batchId,
      caseId,
      caseName,
      category,
      message,
      history,
      expectedOutput,
      sourceTrace,
      memorySetup,
      memoryAssertions,
    } = job.data;
    const startTime = Date.now();

    const userId = `scenario-test-${batchId}`;
    const sessionId = `test-${caseId}`;

    this.logger.log(
      `[TestSuite] 执行测试: ${caseName} (${job.data.caseIndex + 1}/${job.data.totalCases})`,
    );

    try {
      await job.progress(10);

      const result = await this.executionService.executeTest({
        message,
        history,
        caseId,
        caseName,
        category,
        expectedOutput,
        sourceTrace: sourceTrace ?? undefined,
        memorySetup: memorySetup ?? undefined,
        memoryAssertions: memoryAssertions ?? undefined,
        batchId,
        saveExecution: false,
        userId: `${userId}-${caseId}`,
        sessionId,
      });

      await job.progress(80);

      await this.updateExecutionRecord(batchId, caseId, result);

      await job.progress(100);

      const durationMs = Date.now() - startTime;

      return {
        executionId: result.executionId || caseId,
        status: result.status,
        durationMs,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage?.includes('timeout') || durationMs >= this.jobTimeoutMs;

      this.logger.error(`[TestSuite] 测试执行失败: ${caseName} - ${errorMessage}`);

      await this.updateExecutionRecordFailed(batchId, caseId, errorMessage);

      return {
        executionId: caseId,
        status: isTimeout ? ExecutionStatus.TIMEOUT : ExecutionStatus.FAILURE,
        durationMs,
        error: errorMessage,
      };
    }
  }

  private async onJobCompleted(job: Job<TestJobData>, result: TestJobResult): Promise<void> {
    const { batchId, totalCases, caseName } = job.data;

    this.logger.log(`[TestSuite] ✅ 任务完成: ${caseName} (${result.durationMs}ms)`);

    this.updateProgressCache(batchId, result);

    await this.checkBatchCompletion(batchId, totalCases);
  }

  private async onJobFailed(job: Job<TestJobData>, error: Error): Promise<void> {
    const { batchId, totalCases, caseName, caseId } = job.data;
    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts || 1;

    const isFinalAttempt = attemptsMade >= maxAttempts;

    if (!isFinalAttempt) {
      this.logger.warn(
        `[TestSuite] ⚠️ 任务失败将重试: ${caseName} (${attemptsMade}/${maxAttempts}) - ${error.message}`,
      );
      return;
    }

    this.logger.error(
      `[TestSuite] ❌ 任务最终失败: ${caseName} (已重试 ${attemptsMade} 次) - ${error.message}`,
    );

    this.updateProgressCache(batchId, {
      executionId: caseId,
      status: ExecutionStatus.FAILURE,
      durationMs: 0,
      error: error.message,
    });

    await this.updateExecutionRecordFailed(batchId, caseId, error.message);

    await this.checkBatchCompletion(batchId, totalCases);
  }

  private async updateExecutionRecord(
    batchId: string,
    caseId: string,
    result: ExecutionRecordUpdate,
  ): Promise<void> {
    await this.executionService.updateExecutionByBatchAndCase(batchId, caseId, {
      agentRequest: result.request.body,
      agentResponse: result.response.body,
      actualOutput: result.actualOutput,
      toolCalls: result.response.toolCalls || [],
      executionStatus: result.status,
      durationMs: result.metrics.durationMs,
      tokenUsage: result.metrics.tokenUsage,
      executionTrace: result.trace?.executionTrace,
      memoryTrace: result.trace?.memoryTrace,
    });
    this.logger.debug(`[TestSuite] 更新执行记录成功: ${caseId}`);
  }

  private async updateExecutionRecordFailed(
    batchId: string,
    caseId: string,
    errorMsg: string,
  ): Promise<boolean> {
    try {
      await this.executionService.updateExecutionByBatchAndCase(batchId, caseId, {
        executionStatus: ExecutionStatus.FAILURE,
        durationMs: 0,
        errorMessage: errorMsg,
      });
      this.logger.debug(`[TestSuite] 标记执行记录为失败: ${caseId}`);
      return true;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TestSuite] 更新执行记录失败状态失败: ${errMsg}`);
      return false;
    }
  }

  // ==================== Redis 进度缓存操作 ====================

  private getProgressCacheKey(batchId: string): string {
    return `${this.PROGRESS_CACHE_PREFIX}${batchId}`;
  }

  private async getProgressCache(batchId: string): Promise<{
    completedCases: number;
    successCount: number;
    failureCount: number;
    durations: number[];
  } | null> {
    const key = this.getProgressCacheKey(batchId);
    return this.redisService.get(key);
  }

  private async setProgressCache(
    batchId: string,
    cache: {
      completedCases: number;
      successCount: number;
      failureCount: number;
      durations: number[];
    },
  ): Promise<void> {
    const key = this.getProgressCacheKey(batchId);
    await this.redisService.setex(key, this.PROGRESS_CACHE_TTL, cache);
  }

  private async deleteProgressCache(batchId: string): Promise<void> {
    const key = this.getProgressCacheKey(batchId);
    await this.redisService.del(key);
  }

  private async updateProgressCache(batchId: string, result: TestJobResult): Promise<void> {
    let cache = await this.getProgressCache(batchId);
    if (!cache) {
      cache = { completedCases: 0, successCount: 0, failureCount: 0, durations: [] };
    }

    cache.completedCases++;
    if (result.status === ExecutionStatus.SUCCESS) {
      cache.successCount++;
    } else {
      cache.failureCount++;
    }
    cache.durations.push(result.durationMs);

    await this.setProgressCache(batchId, cache);
  }

  private async checkBatchCompletion(batchId: string, totalCases: number): Promise<void> {
    let dbStats: { total: number; success: number; failure: number; timeout: number };
    try {
      dbStats = await this.executionService.countCompletedExecutions(batchId);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TestSuite] 查询执行记录失败: ${errorMessage}`);
      return;
    }

    this.logger.debug(`[TestSuite] 批次 ${batchId} 进度: ${dbStats.total}/${totalCases} 完成`);

    if (dbStats.total >= totalCases) {
      this.logger.log(
        `[TestSuite] 📊 批次 ${batchId} 全部完成: ${dbStats.success}/${totalCases} 成功`,
      );

      try {
        await this.batchService.updateBatchStats(batchId);
        await this.batchService.updateBatchStatus(batchId, BatchStatus.REVIEWING);
        this.logger.log(`[TestSuite] 批次 ${batchId} 状态已更新为 reviewing`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`[TestSuite] 更新批次状态失败: ${errorMessage}`);
      }

      await this.deleteProgressCache(batchId);
    }
  }

  // ==================== 公共 API ====================

  async addTestJob(
    jobData: TestJobData,
    options?: { priority?: number; delay?: number },
  ): Promise<Job<TestJobData>> {
    return this.testQueue.add('execute-test', jobData, {
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      timeout: this.jobTimeoutMs,
      priority: options?.priority,
      delay: options?.delay,
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async addBatchTestJobs(
    batchId: string,
    cases: Array<{
      caseId: string;
      caseName: string;
      category?: string;
      message: string;
      history?: Array<{ role: MessageRole; content: string }>;
      expectedOutput?: string;
      sourceTrace?: TestSourceTrace | null;
      memorySetup?: MemoryFixtureSetup | null;
      memoryAssertions?: MemoryAssertions | null;
    }>,
  ): Promise<Job<TestJobData>[]> {
    const totalCases = cases.length;

    await this.setProgressCache(batchId, {
      completedCases: 0,
      successCount: 0,
      failureCount: 0,
      durations: [],
    });

    const jobs: Job<TestJobData>[] = [];

    for (let i = 0; i < cases.length; i++) {
      const testCase = cases[i];
      const job = await this.addTestJob({
        batchId,
        caseId: testCase.caseId,
        caseName: testCase.caseName,
        category: testCase.category,
        message: testCase.message,
        history: testCase.history,
        expectedOutput: testCase.expectedOutput,
        sourceTrace: testCase.sourceTrace,
        memorySetup: testCase.memorySetup,
        memoryAssertions: testCase.memoryAssertions,
        totalCases,
        caseIndex: i,
      });
      jobs.push(job);
    }

    this.logger.log(`[TestSuite] 已添加 ${jobs.length} 个测试任务到队列`);
    return jobs;
  }

  async getBatchProgress(batchId: string): Promise<BatchProgress> {
    const cache = await this.getProgressCache(batchId);

    const batch = await this.batchService.getBatch(batchId);
    if (!batch) {
      throw new Error(`批次 ${batchId} 不存在`);
    }

    const completedCases = cache?.completedCases ?? batch.executed_count;
    const successCount = cache?.successCount ?? batch.passed_count;
    const failureCount = cache?.failureCount ?? batch.failed_count;
    const totalCases = batch.total_cases;

    const progress = totalCases > 0 ? Math.round((completedCases / totalCases) * 100) : 0;

    let estimatedRemainingMs: number | undefined;
    let avgDurationMs: number | undefined;

    if (cache && cache.durations.length > 0) {
      avgDurationMs = Math.round(
        cache.durations.reduce((a, b) => a + b, 0) / cache.durations.length,
      );
      const remainingCases = totalCases - completedCases;
      estimatedRemainingMs = remainingCases * avgDurationMs;
    }

    return {
      batchId,
      status: batch.status,
      totalCases,
      completedCases,
      successCount,
      failureCount,
      progress,
      estimatedRemainingMs,
      avgDurationMs,
    };
  }

  async getQueueStatus(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.testQueue.getWaitingCount(),
      this.testQueue.getActiveCount(),
      this.testQueue.getCompletedCount(),
      this.testQueue.getFailedCount(),
      this.testQueue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  async cancelBatchJobs(batchId: string): Promise<{
    waiting: number;
    delayed: number;
    active: number;
  }> {
    let waitingCancelled = 0;
    let delayedCancelled = 0;
    let activeCancelled = 0;

    const waitingJobs = await this.testQueue.getWaiting();
    for (const job of waitingJobs) {
      if (job.data.batchId === batchId) {
        await job.remove();
        waitingCancelled++;
      }
    }

    const delayedJobs = await this.testQueue.getDelayed();
    for (const job of delayedJobs) {
      if (job.data.batchId === batchId) {
        await job.remove();
        delayedCancelled++;
      }
    }

    const activeJobs = await this.testQueue.getActive();
    for (const job of activeJobs) {
      if (job.data.batchId === batchId) {
        await job.discard();
        activeCancelled++;
      }
    }

    await this.deleteProgressCache(batchId);

    this.logger.log(
      `[TestSuite] 批次 ${batchId} 取消完成: 等待=${waitingCancelled}, 延迟=${delayedCancelled}, 执行中=${activeCancelled}`,
    );

    return {
      waiting: waitingCancelled,
      delayed: delayedCancelled,
      active: activeCancelled,
    };
  }

  async cleanFailedJobs(): Promise<number> {
    const failedJobs = await this.testQueue.getFailed();
    for (const job of failedJobs) {
      await job.remove();
    }
    return failedJobs.length;
  }

  private readPositiveInt(
    key: string,
    fallback: number,
    bounds: { min: number; max: number },
  ): number {
    const raw = this.configService.get<string | number>(key);
    const parsed = typeof raw === 'number' ? raw : Number(raw);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    const normalized = Math.floor(parsed);
    if (normalized < bounds.min) {
      return bounds.min;
    }
    if (normalized > bounds.max) {
      return bounds.max;
    }
    return normalized;
  }
}
