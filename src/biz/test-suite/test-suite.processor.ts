import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import { TestSuiteService } from './test-suite.service';
import { TestBatch } from './entities';
import { RedisService } from '@core/redis/redis.service';
import { ExecutionStatus, MessageRole, BatchStatus } from './enums';

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
  // 任务元信息
  totalCases: number;
  caseIndex: number; // 当前是第几个用例（0-based）
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
  progress: number; // 0-100
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
}

/**
 * 测试套件任务队列处理器
 *
 * 职责：
 * - 处理 Bull Queue 中的测试任务
 * - 支持长时间运行的任务（30-50秒）
 * - 提供任务进度查询
 * - 批次完成自动更新状态
 *
 * 队列名: 'test-suite'
 * Job 类型: 'execute-test' - 执行单个测试用例
 *
 * 架构说明：
 * - 使用 forwardRef() 处理与 TestSuiteService 的循环依赖
 * - 这是 NestJS 官方推荐的做法（见 https://docs.nestjs.com/fundamentals/circular-dependency）
 * - Processor 需要调用 Service 执行测试和更新记录
 * - Service 需要调用 Processor 添加任务到队列
 * - 替代方案（EventEmitter）会增加复杂度，目前不需要
 */
@Injectable()
export class TestSuiteProcessor implements OnModuleInit {
  private readonly logger = new Logger(TestSuiteProcessor.name);

  // Worker 配置
  private readonly CONCURRENCY = 3; // 并发执行数（Agent 调用耗时长，不宜太高）
  private readonly JOB_TIMEOUT_MS = 120_000; // 单个任务超时时间 2 分钟

  // Redis 缓存配置
  private readonly PROGRESS_CACHE_PREFIX = 'test-suite:progress:';
  private readonly PROGRESS_CACHE_TTL = 3600; // 1 小时过期

  constructor(
    @InjectQueue('test-suite') private readonly testQueue: Queue<TestJobData>,
    // forwardRef 用于解决循环依赖：Processor ↔ Service
    @Inject(forwardRef(() => TestSuiteService))
    private readonly testSuiteService: TestSuiteService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    await this.waitForQueueReady();
    this.registerWorkers();
    this.setupQueueEventListeners();

    this.logger.log(
      `TestSuiteProcessor 已初始化（并发数: ${this.CONCURRENCY}, 超时: ${this.JOB_TIMEOUT_MS}ms）`,
    );
  }

  /**
   * 等待队列就绪
   */
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

  /**
   * 注册 Worker
   */
  private registerWorkers(): void {
    this.logger.log(`[TestSuite] 注册 Worker，并发数: ${this.CONCURRENCY}...`);

    this.testQueue.process('execute-test', this.CONCURRENCY, async (job: Job<TestJobData>) => {
      return this.handleTestJob(job);
    });

    this.logger.log('[TestSuite] ✅ Worker 已注册');
  }

  /**
   * 设置队列事件监听
   */
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

  /**
   * 处理测试任务
   */
  private async handleTestJob(job: Job<TestJobData>): Promise<TestJobResult> {
    const { batchId, caseId, caseName, category, message, history, expectedOutput } = job.data;
    const startTime = Date.now();

    // 自动生成 userId（批次级别唯一）和 sessionId（用例级别唯一）
    // userId + sessionId 是 Agent 会话记忆的组合 key
    const userId = `scenario-test-${batchId}`;
    const sessionId = `test-${caseId}`;

    this.logger.log(
      `[TestSuite] 执行测试: ${caseName} (${job.data.caseIndex + 1}/${job.data.totalCases})`,
    );

    try {
      // 更新任务进度
      await job.progress(10);

      // 执行测试
      const result = await this.testSuiteService.executeTest({
        message,
        history,
        caseId,
        caseName,
        category,
        expectedOutput,
        batchId,
        saveExecution: false, // 已经保存过了，这里只更新
        userId,
        sessionId,
      });

      // 更新进度到 80%
      await job.progress(80);

      // 更新执行记录
      await this.updateExecutionRecord(batchId, caseId, result);

      // 更新进度到 100%
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
      const isTimeout = errorMessage?.includes('timeout') || durationMs >= this.JOB_TIMEOUT_MS;

      this.logger.error(`[TestSuite] 测试执行失败: ${caseName} - ${errorMessage}`);

      // 更新执行记录为失败状态
      await this.updateExecutionRecordFailed(batchId, caseId, errorMessage);

      return {
        executionId: caseId,
        status: isTimeout ? ExecutionStatus.TIMEOUT : ExecutionStatus.FAILURE,
        durationMs,
        error: errorMessage,
      };
    }
  }

  /**
   * 任务完成回调
   */
  private async onJobCompleted(job: Job<TestJobData>, result: TestJobResult): Promise<void> {
    const { batchId, totalCases, caseName } = job.data;

    this.logger.log(`[TestSuite] ✅ 任务完成: ${caseName} (${result.durationMs}ms)`);

    // 更新进度缓存
    this.updateProgressCache(batchId, result);

    // 检查批次是否全部完成
    await this.checkBatchCompletion(batchId, totalCases);
  }

  /**
   * 任务失败回调
   * 注意：只在最终失败时（用尽所有重试次数后）更新进度统计
   */
  private async onJobFailed(job: Job<TestJobData>, error: Error): Promise<void> {
    const { batchId, totalCases, caseName, caseId } = job.data;
    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts || 1;

    // 判断是否已用尽所有重试次数
    const isFinalAttempt = attemptsMade >= maxAttempts;

    if (!isFinalAttempt) {
      // 还有重试机会，不更新统计，只记录日志
      this.logger.warn(
        `[TestSuite] ⚠️ 任务失败将重试: ${caseName} (${attemptsMade}/${maxAttempts}) - ${error.message}`,
      );
      return;
    }

    // 最终失败，更新统计
    this.logger.error(
      `[TestSuite] ❌ 任务最终失败: ${caseName} (已重试 ${attemptsMade} 次) - ${error.message}`,
    );

    // 更新进度缓存
    this.updateProgressCache(batchId, {
      executionId: caseId,
      status: ExecutionStatus.FAILURE,
      durationMs: 0,
      error: error.message,
    });

    // 确保执行记录被标记为失败
    await this.updateExecutionRecordFailed(batchId, caseId, error.message);

    // 检查批次是否全部完成
    await this.checkBatchCompletion(batchId, totalCases);
  }

  /**
   * 更新执行记录
   */
  private async updateExecutionRecord(
    batchId: string,
    caseId: string,
    result: ExecutionRecordUpdate,
  ): Promise<void> {
    try {
      await this.testSuiteService.updateExecutionByBatchAndCase(batchId, caseId, {
        agentRequest: result.request.body,
        agentResponse: result.response.body,
        actualOutput: result.actualOutput,
        toolCalls: result.response.toolCalls || [],
        executionStatus: result.status,
        durationMs: result.metrics.durationMs,
        tokenUsage: result.metrics.tokenUsage,
      });
      this.logger.debug(`[TestSuite] 更新执行记录成功: ${caseId}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TestSuite] 更新执行记录失败: ${errorMessage}`);
    }
  }

  /**
   * 更新执行记录为失败状态
   */
  private async updateExecutionRecordFailed(
    batchId: string,
    caseId: string,
    errorMsg: string,
  ): Promise<void> {
    try {
      await this.testSuiteService.updateExecutionByBatchAndCase(batchId, caseId, {
        executionStatus: ExecutionStatus.FAILURE,
        durationMs: 0,
        errorMessage: errorMsg,
      });
      this.logger.debug(`[TestSuite] 标记执行记录为失败: ${caseId}`);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TestSuite] 更新执行记录失败状态失败: ${errMsg}`);
    }
  }

  // ==================== Redis 进度缓存操作 ====================

  /**
   * 获取 Redis 缓存 key
   */
  private getProgressCacheKey(batchId: string): string {
    return `${this.PROGRESS_CACHE_PREFIX}${batchId}`;
  }

  /**
   * 从 Redis 获取进度缓存
   */
  private async getProgressCache(batchId: string): Promise<{
    completedCases: number;
    successCount: number;
    failureCount: number;
    durations: number[];
  } | null> {
    const key = this.getProgressCacheKey(batchId);
    return this.redisService.get(key);
  }

  /**
   * 保存进度缓存到 Redis
   */
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

  /**
   * 删除 Redis 进度缓存
   */
  private async deleteProgressCache(batchId: string): Promise<void> {
    const key = this.getProgressCacheKey(batchId);
    await this.redisService.del(key);
  }

  /**
   * 更新进度缓存（原子操作，使用 Redis）
   */
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

  /**
   * 检查批次是否完成
   *
   * 策略：
   * - 始终以数据库查询结果为准（避免 Redis 缓存竞态条件导致计数不准确）
   * - Redis 缓存仅用于实时进度展示，不影响完成判断
   */
  private async checkBatchCompletion(batchId: string, totalCases: number): Promise<void> {
    // 直接查询数据库获取准确的执行记录统计
    let dbStats: { total: number; success: number; failure: number; timeout: number };
    try {
      dbStats = await this.testSuiteService.countCompletedExecutions(batchId);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TestSuite] 查询执行记录失败: ${errorMessage}`);
      return;
    }

    this.logger.debug(`[TestSuite] 批次 ${batchId} 进度: ${dbStats.total}/${totalCases} 完成`);

    // 检查是否全部完成
    if (dbStats.total >= totalCases) {
      this.logger.log(
        `[TestSuite] 📊 批次 ${batchId} 全部完成: ${dbStats.success}/${totalCases} 成功`,
      );

      // 更新批次统计和状态
      try {
        await this.testSuiteService.updateBatchStats(batchId);
        await this.testSuiteService.updateBatchStatus(batchId, BatchStatus.REVIEWING);
        this.logger.log(`[TestSuite] 批次 ${batchId} 状态已更新为 reviewing`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`[TestSuite] 更新批次状态失败: ${errorMessage}`);
      }

      // 清理 Redis 缓存
      await this.deleteProgressCache(batchId);
    }
  }

  // ==================== 公共 API ====================

  /**
   * 将测试用例添加到队列
   */
  async addTestJob(
    jobData: TestJobData,
    options?: { priority?: number; delay?: number },
  ): Promise<Job<TestJobData>> {
    return this.testQueue.add('execute-test', jobData, {
      attempts: 2, // 失败重试 1 次
      backoff: {
        type: 'exponential',
        delay: 5000, // 5 秒后重试
      },
      timeout: this.JOB_TIMEOUT_MS,
      priority: options?.priority,
      delay: options?.delay,
      removeOnComplete: true,
      removeOnFail: false, // 保留失败任务用于调试
    });
  }

  /**
   * 批量添加测试任务到队列
   */
  async addBatchTestJobs(
    batchId: string,
    cases: Array<{
      caseId: string;
      caseName: string;
      category?: string;
      message: string;
      history?: Array<{ role: MessageRole; content: string }>;
      expectedOutput?: string;
    }>,
  ): Promise<Job<TestJobData>[]> {
    const totalCases = cases.length;

    // 初始化 Redis 进度缓存
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
        totalCases,
        caseIndex: i,
      });
      jobs.push(job);
    }

    this.logger.log(`[TestSuite] 已添加 ${jobs.length} 个测试任务到队列`);
    return jobs;
  }

  /**
   * 获取批次执行进度
   */
  async getBatchProgress(batchId: string): Promise<BatchProgress> {
    // 1. 从 Redis 获取实时进度
    const cache = await this.getProgressCache(batchId);

    // 2. 获取批次基本信息
    const batch = await this.testSuiteService.getBatch(batchId);
    if (!batch) {
      throw new Error(`批次 ${batchId} 不存在`);
    }

    // 3. 计算进度
    const completedCases = cache?.completedCases ?? batch.executed_count;
    const successCount = cache?.successCount ?? batch.passed_count;
    const failureCount = cache?.failureCount ?? batch.failed_count;
    const totalCases = batch.total_cases;

    const progress = totalCases > 0 ? Math.round((completedCases / totalCases) * 100) : 0;

    // 4. 估算剩余时间
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

  /**
   * 获取队列状态
   */
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

  /**
   * 取消批次中所有任务（等待中 + 延迟中 + 正在执行）
   *
   * 注意：正在执行的任务无法立即停止（Agent API 调用已发出），
   * 但会被标记为 discarded，完成后不更新统计。
   */
  async cancelBatchJobs(batchId: string): Promise<{
    waiting: number;
    delayed: number;
    active: number;
  }> {
    let waitingCancelled = 0;
    let delayedCancelled = 0;
    let activeCancelled = 0;

    // 1. 取消等待中的任务
    const waitingJobs = await this.testQueue.getWaiting();
    for (const job of waitingJobs) {
      if (job.data.batchId === batchId) {
        await job.remove();
        waitingCancelled++;
      }
    }

    // 2. 取消延迟中的任务
    const delayedJobs = await this.testQueue.getDelayed();
    for (const job of delayedJobs) {
      if (job.data.batchId === batchId) {
        await job.remove();
        delayedCancelled++;
      }
    }

    // 3. 标记正在执行的任务（无法立即停止，但标记后完成时不更新统计）
    const activeJobs = await this.testQueue.getActive();
    for (const job of activeJobs) {
      if (job.data.batchId === batchId) {
        // 使用 job.discard() 标记任务被丢弃，完成后不触发 completed 事件
        await job.discard();
        activeCancelled++;
      }
    }

    // 4. 清理 Redis 进度缓存
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

  /**
   * 清理失败的任务
   */
  async cleanFailedJobs(): Promise<number> {
    const failedJobs = await this.testQueue.getFailed();
    for (const job of failedJobs) {
      await job.remove();
    }
    return failedJobs.length;
  }
}
