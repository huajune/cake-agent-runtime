import type { TestChatRequestDto } from './dto/test-chat.dto';
import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import BullQueue = require('bull');
import { Queue, Job } from 'bull';
import { resolveBullPrefix } from '@infra/queue/bull.module';
import { QUEUE_WORKER_SETTINGS } from '@infra/queue/queue-policy';
import { TestBatchService } from './services/test-batch.service';
import { TestExecutionService } from './services/test-execution.service';
import { TestBatch } from './entities/test-batch.entity';
import { RedisService } from '@infra/redis/redis.service';
import { ExecutionStatus, MessageRole, BatchStatus } from './enums/test.enum';
import type { GeneratorToolMode } from '@agent/generator/generator.types';
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
  request?: TestChatRequestDto;
  batchId: string;
  caseId: string;
  caseName: string;
  category?: string;
  message: string;
  history?: Array<{ role: MessageRole; content: string }>;
  expectedOutput?: string;
  toolMode?: GeneratorToolMode;
  allowedToolNames?: string[];
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

@Injectable()
export class TestSuiteProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TestSuiteProcessor.name);

  private readonly workers: Queue<TestJobData>[] = [];
  private readonly workerConnections: Queue['client'][] = [];
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
    // 托管 Redis 会延迟同一阻塞连接上流水化 BRPOPLPUSH 的回复，导致任务
    // 已移入 active 却尚未拿到 Bull 锁。每个并发槽使用独立 bclient，普通
    // client 复用生产者，subscriber 在本组 worker 间共享。
    if (this.configService.get<string>('UPSTASH_REDIS_TCP_URL')) {
      const subscriber = this.testQueue.client.duplicate({
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      this.workerConnections.push(subscriber);
      for (let index = 0; index < this.concurrency; index++) {
        const worker = new BullQueue<TestJobData>(this.testQueue.name, {
          prefix: resolveBullPrefix(this.configService),
          settings: QUEUE_WORKER_SETTINGS,
          createClient: (type) => {
            if (type === 'client') return this.testQueue.client;
            if (type === 'subscriber') return subscriber;
            const blocking = this.testQueue.client.duplicate({
              maxRetriesPerRequest: null,
              enableReadyCheck: false,
            });
            this.workerConnections.push(blocking);
            return blocking;
          },
        });
        this.workers.push(worker);
        this.setupQueueEventListeners(worker);
        worker.process('execute-test', 1, (job) => this.handleTestJob(job));
      }
    } else {
      this.setupQueueEventListeners(this.testQueue);
      this.testQueue.process('execute-test', this.concurrency, (job) => this.handleTestJob(job));
    }
    this.logger.log(`[TestSuite] Worker 已注册，并发数: ${this.concurrency}`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all(this.workerConnections.map((connection) => connection.quit()));
  }

  private setupQueueEventListeners(queue: Queue<TestJobData>): void {
    queue.on('completed', (job: Job<TestJobData>, result: TestJobResult) => {
      this.onJobCompleted(job, result);
    });

    queue.on('failed', (job: Job<TestJobData>, error: Error) => {
      this.onJobFailed(job, error);
    });

    queue.on('active', (job: Job<TestJobData>) => {
      this.logger.log(`[TestSuite] 🔄 任务 ${job.id} 开始: ${job.data.caseName}`);
    });

    queue.on('stalled', (job: Job<TestJobData>) => {
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
      toolMode,
      allowedToolNames,
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
      if (job.data.request) {
        const batch = await this.batchService.getBatch(batchId);
        if (!batch || batch.status === BatchStatus.CANCELLED) {
          throw new Error('批次已取消或不存在');
        }
      }
      await job.progress(10);

      const result = await this.executionService.executeTest({
        ...job.data.request,
        message,
        history,
        caseId,
        caseName,
        category,
        expectedOutput,
        // undefined 继续由生成链路按 scenario 处理；空数组必须原样保留，表示无工具授权。
        toolMode,
        allowedToolNames,
        sourceTrace: sourceTrace ?? undefined,
        memorySetup: memorySetup ?? undefined,
        memoryAssertions: memoryAssertions ?? undefined,
        batchId,
        saveExecution: false,
        userId: job.data.request?.userId ?? `${userId}-${caseId}`,
        sessionId: job.data.request?.sessionId ?? sessionId,
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
      const errorMessage = toErrorMessage(error);
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
      const errMsg = toErrorMessage(error);
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
      const errorMessage = toErrorMessage(error);
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
        const errorMessage = toErrorMessage(error);
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

  async addPreparedBatchJobs(
    batchId: string,
    cases: Array<TestChatRequestDto & { caseId: string; caseName: string }>,
  ): Promise<Job<TestJobData>[]> {
    await this.setProgressCache(batchId, {
      completedCases: 0,
      successCount: 0,
      failureCount: 0,
      durations: [],
    });
    // 所有执行记录先持久化；等待每个入队请求结束后再返回或报告失败。
    const admitted = await Promise.allSettled(
      cases.map((request, caseIndex) =>
        this.testQueue.add(
          'execute-test',
          {
            ...request,
            message: request.message ?? '',
            request,
            batchId,
            totalCases: cases.length,
            caseIndex,
          },
          {
            jobId: `${batchId}-${caseIndex}`,
            attempts: 1,
            timeout: this.jobTimeoutMs,
            removeOnComplete: true,
            removeOnFail: false,
          },
        ),
      ),
    );
    const failure = admitted.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return admitted.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
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
      toolMode?: GeneratorToolMode;
      allowedToolNames?: string[];
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
        toolMode: testCase.toolMode,
        allowedToolNames: testCase.allowedToolNames,
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
