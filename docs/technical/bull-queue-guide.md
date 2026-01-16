# Bull Queue 使用指南

> 精简实战指南 - 基于项目实际应用总结

## 概述

Bull 是基于 Redis 的任务队列库，用于处理异步任务和后台任务。

**项目中的应用场景**：
1. **消息聚合队列** (`message-merge`) - 聚合用户短时间内的多条消息
2. **测试执行队列** (`test-suite`) - 并发执行 AI Agent 测试用例

**核心优势**：
- ✅ 自动重试机制
- ✅ 任务持久化（Redis 存储）
- ✅ 并发控制
- ✅ 任务优先级
- ✅ 延迟任务
- ✅ 进度跟踪

## 快速开始

### 1. 安装依赖

```bash
pnpm add @nestjs/bull bull
pnpm add -D @types/bull
```

### 2. 配置 Redis

```typescript
// app.module.ts
import { BullModule } from '@nestjs/bull';

@Module({
  imports: [
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
      },
    }),
  ],
})
export class AppModule {}
```

**Upstash Redis REST API 配置**：

```typescript
// redis.module.ts
BullModule.forRoot({
  redis: {
    host: new URL(process.env.UPSTASH_REDIS_REST_URL).hostname,
    port: 443,
    password: process.env.UPSTASH_REDIS_REST_TOKEN,
    tls: {}, // 启用 TLS
  },
})
```

### 3. 注册队列

```typescript
// message.module.ts
import { BullModule } from '@nestjs/bull';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'message-merge', // 队列名称
    }),
  ],
  providers: [MessageService, MessageProcessor],
})
export class MessageModule {}
```

## 核心概念

### Queue（队列）

负责添加任务到队列。

```typescript
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@Injectable()
export class MessageService {
  constructor(
    @InjectQueue('message-merge')
    private readonly messageQueue: Queue,
  ) {}

  async addJob(data: any) {
    return this.messageQueue.add('process', data, {
      attempts: 3,      // 重试 3 次
      backoff: 5000,    // 重试延迟 5 秒
      timeout: 30000,   // 超时 30 秒
      priority: 1,      // 优先级（数字越小越优先）
      delay: 1000,      // 延迟 1 秒执行
    });
  }
}
```

### Processor（处理器）

负责消费队列中的任务。

```typescript
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';

@Processor('message-merge')
export class MessageProcessor {
  private readonly logger = new Logger(MessageProcessor.name);

  @Process('process')  // 处理 'process' 类型的任务
  async handleJob(job: Job) {
    this.logger.log(`处理任务: ${job.id}`);

    // 业务逻辑
    const result = await this.processMessage(job.data);

    // 更新进度
    await job.progress(100);

    return result;
  }
}
```

### Worker（工作进程）

Bull 会根据并发数创建多个 Worker 处理任务。

```typescript
@Processor('test-suite')
export class TestProcessor implements OnModuleInit {
  private readonly CONCURRENCY = 3; // 并发数

  async onModuleInit() {
    this.registerWorkers();
  }

  private registerWorkers() {
    // 注册 Worker，指定并发数
    this.testQueue.process(
      'execute-test',
      this.CONCURRENCY,  // 3 个 Worker 并发处理
      async (job: Job) => {
        return this.handleJob(job);
      }
    );
  }
}
```

## 项目实战案例

### 案例 1: 消息聚合队列

**场景**：用户在 1 秒内发送多条消息，聚合后一次性调用 Agent API。

**实现**：

```typescript
// simple-merge.service.ts
@Injectable()
export class SimpleMergeService {
  constructor(
    @InjectQueue('message-merge')
    private readonly messageQueue: Queue,
    private readonly redisService: RedisService,
  ) {}

  async addMessage(chatId: string, message: EnterpriseMessageCallbackDto) {
    // 1. 将消息存入 Redis
    await this.savePendingMessage(chatId, message);

    // 2. 检查是否已有等待中的任务
    const existingJob = await this.findPendingJob(chatId);
    if (existingJob) {
      this.logger.debug(`任务已存在，跳过创建`);
      return;
    }

    // 3. 创建延迟任务（1 秒后执行）
    const job = await this.messageQueue.add(
      'process',
      { chatId },
      {
        delay: 1000,           // 延迟 1 秒
        jobId: `merge:${chatId}:${Date.now()}`,
        removeOnComplete: true,
      }
    );

    this.logger.log(`创建聚合任务: ${job.id}`);
  }

  private async findPendingJob(chatId: string): Promise<Job | null> {
    const [waiting, delayed] = await Promise.all([
      this.messageQueue.getWaiting(),
      this.messageQueue.getDelayed(),
    ]);

    for (const job of [...waiting, ...delayed]) {
      if (job.data.chatId === chatId) {
        return job;
      }
    }
    return null;
  }
}
```

```typescript
// message.processor.ts
@Processor('message-merge')
export class MessageProcessor {
  @Process('process')
  async handleProcessJob(job: Job<{ chatId: string }>) {
    const { chatId } = job.data;

    // 1. 从 Redis 获取聚合的消息
    const messages = await this.simpleMergeService
      .getAndClearPendingMessages(chatId);

    if (messages.length === 0) {
      return;
    }

    // 2. 调用 Agent API
    await this.messageService.processMergedMessages(messages);

    // 3. 处理完后检查是否有新消息
    await this.simpleMergeService.checkAndProcessNewMessages(chatId);
  }
}
```

**关键设计**：
- 任务数据只存 `chatId`，消息内容存 Redis（避免 Bull Queue 数据过大）
- 使用 `delay` 等待聚合窗口
- 使用 `jobId` 防止重复创建任务

### 案例 2: 测试执行队列

**场景**：批量执行 AI Agent 测试用例，支持并发控制、进度跟踪、失败重试。

**实现**：

```typescript
// test-suite.processor.ts
@Processor('test-suite')
export class TestSuiteProcessor implements OnModuleInit {
  private readonly CONCURRENCY = 3;    // 并发数
  private readonly JOB_TIMEOUT_MS = 120_000;  // 超时 2 分钟

  constructor(
    @InjectQueue('test-suite')
    private readonly testQueue: Queue<TestJobData>,
  ) {}

  async onModuleInit() {
    await this.waitForQueueReady();
    this.registerWorkers();
    this.setupEventListeners();
  }

  private registerWorkers() {
    this.testQueue.process(
      'execute-test',
      this.CONCURRENCY,  // 3 个 Worker 并发
      async (job: Job<TestJobData>) => {
        return this.handleTestJob(job);
      }
    );
  }

  private async handleTestJob(job: Job<TestJobData>) {
    const { caseId, message, history } = job.data;
    const startTime = Date.now();

    try {
      // 更新进度
      await job.progress(10);

      // 执行测试
      const result = await this.testSuiteService.executeTest({
        message,
        history,
        caseId,
      });

      await job.progress(80);

      // 更新执行记录
      await this.updateExecutionRecord(result);

      await job.progress(100);

      return {
        executionId: caseId,
        status: result.status,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      throw error; // Bull 会自动重试
    }
  }

  private setupEventListeners() {
    this.testQueue.on('completed', (job, result) => {
      this.logger.log(`✅ 任务完成: ${job.id}`);
      this.updateProgressCache(result);
      this.checkBatchCompletion(job.data.batchId);
    });

    this.testQueue.on('failed', (job, error) => {
      const isFinalAttempt = job.attemptsMade >= job.opts.attempts;
      if (isFinalAttempt) {
        this.logger.error(`❌ 任务最终失败: ${job.id}`);
        this.updateProgressCache({ status: 'FAILURE' });
      } else {
        this.logger.warn(`⚠️ 任务失败将重试: ${job.id}`);
      }
    });
  }
}
```

**批量添加任务**：

```typescript
async addBatchTestJobs(batchId: string, cases: TestCase[]) {
  const jobs = [];

  for (let i = 0; i < cases.length; i++) {
    const job = await this.testQueue.add('execute-test', {
      batchId,
      caseId: cases[i].id,
      message: cases[i].message,
      totalCases: cases.length,
      caseIndex: i,
    }, {
      attempts: 2,         // 失败重试 1 次
      backoff: {
        type: 'exponential',
        delay: 5000,       // 5 秒后重试
      },
      timeout: this.JOB_TIMEOUT_MS,
      removeOnComplete: true,
      removeOnFail: false, // 保留失败任务用于调试
    });
    jobs.push(job);
  }

  return jobs;
}
```

**关键设计**：
- 并发数设置为 3（Agent API 调用耗时长，不宜太高）
- 使用 `attempts` 自动重试
- 使用 `job.progress()` 跟踪进度
- 使用 Redis 缓存进度统计（避免频繁查询数据库）
- 区分重试失败和最终失败（只在最终失败时更新统计）

## 任务配置选项

### 基本配置

```typescript
queue.add('job-type', data, {
  // 重试配置
  attempts: 3,           // 最多重试 3 次
  backoff: 5000,         // 重试延迟 5 秒
  backoff: {             // 指数退避
    type: 'exponential',
    delay: 2000,         // 首次 2 秒，后续 4 秒、8 秒...
  },

  // 超时配置
  timeout: 30000,        // 30 秒超时

  // 优先级（数字越小越优先）
  priority: 1,

  // 延迟执行
  delay: 5000,           // 延迟 5 秒执行

  // 清理配置
  removeOnComplete: true,   // 完成后自动删除
  removeOnFail: false,      // 失败后保留（用于调试）

  // 任务 ID（用于防重复）
  jobId: 'unique-id',
});
```

### Worker 配置

```typescript
queue.process(
  'job-type',
  concurrency,  // 并发数
  async (job) => {
    // 处理逻辑
  }
);
```

## 队列管理

### 等待队列就绪

```typescript
private async waitForQueueReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (this.queue.client?.status === 'ready') {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error('等待队列就绪超时'));
    }, 30000);

    this.queue.on('ready', () => {
      clearTimeout(timeout);
      resolve();
    });

    this.queue.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
```

### 查询队列状态

```typescript
async getQueueStatus() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    this.queue.getWaitingCount(),
    this.queue.getActiveCount(),
    this.queue.getCompletedCount(),
    this.queue.getFailedCount(),
    this.queue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}
```

### 取消任务

```typescript
// 取消单个任务
const job = await this.queue.getJob(jobId);
await job.remove();

// 取消批次中的所有任务
async cancelBatchJobs(batchId: string) {
  // 1. 取消等待中的任务
  const waitingJobs = await this.queue.getWaiting();
  for (const job of waitingJobs) {
    if (job.data.batchId === batchId) {
      await job.remove();
    }
  }

  // 2. 取消延迟中的任务
  const delayedJobs = await this.queue.getDelayed();
  for (const job of delayedJobs) {
    if (job.data.batchId === batchId) {
      await job.remove();
    }
  }

  // 3. 标记正在执行的任务（无法立即停止）
  const activeJobs = await this.queue.getActive();
  for (const job of activeJobs) {
    if (job.data.batchId === batchId) {
      await job.discard(); // 完成后不触发 completed 事件
    }
  }
}
```

### 清理失败任务

```typescript
async cleanFailedJobs() {
  const failedJobs = await this.queue.getFailed();
  for (const job of failedJobs) {
    await job.remove();
  }
  return failedJobs.length;
}
```

## 事件监听

Bull Queue 提供丰富的事件监听机制。

```typescript
@Processor('my-queue')
export class MyProcessor implements OnModuleInit {
  async onModuleInit() {
    this.setupEventListeners();
  }

  private setupEventListeners() {
    // 任务完成
    this.queue.on('completed', (job: Job, result: any) => {
      this.logger.log(`✅ 任务 ${job.id} 完成`);
    });

    // 任务失败
    this.queue.on('failed', (job: Job, error: Error) => {
      this.logger.error(`❌ 任务 ${job.id} 失败: ${error.message}`);
    });

    // 任务开始
    this.queue.on('active', (job: Job) => {
      this.logger.log(`🔄 任务 ${job.id} 开始处理`);
    });

    // 任务卡住
    this.queue.on('stalled', (job: Job) => {
      this.logger.warn(`⚠️ 任务 ${job.id} 卡住`);
    });

    // 队列清空
    this.queue.on('drained', () => {
      this.logger.log('队列已清空');
    });

    // 连接就绪
    this.queue.on('ready', () => {
      this.logger.log('队列连接就绪');
    });

    // 连接错误
    this.queue.on('error', (error: Error) => {
      this.logger.error('队列连接错误:', error);
    });
  }
}
```

## 最佳实践

### 1. 数据存储策略

**问题**：任务数据过大导致 Redis 内存占用高。

**解决方案**：任务数据只存标识符，实际数据存 Redis。

```typescript
// ❌ 错误：任务数据存消息内容
await queue.add('process', {
  chatId: 'xxx',
  messages: [...], // 可能包含大量消息
});

// ✅ 正确：任务数据只存 chatId，消息存 Redis
await this.redisService.set(`pending:${chatId}`, messages);
await queue.add('process', { chatId });

// Processor 中再获取
const messages = await this.redisService.get(`pending:${chatId}`);
```

### 2. 防止重复任务

**问题**：高并发下可能创建重复任务。

**解决方案**：使用 `jobId` 或查询已有任务。

```typescript
// 方案 1: 使用 jobId（推荐）
await queue.add('process', data, {
  jobId: `merge:${chatId}:${timestamp}`,
});

// 方案 2: 查询已有任务
const existingJob = await this.findPendingJob(chatId);
if (existingJob) {
  return;
}
await queue.add('process', data);
```

### 3. 进度跟踪

**使用场景**：长时间运行的任务需要展示进度。

```typescript
@Process('long-task')
async handleLongTask(job: Job) {
  await job.progress(0);

  // 步骤 1
  await this.step1();
  await job.progress(25);

  // 步骤 2
  await this.step2();
  await job.progress(50);

  // 步骤 3
  await this.step3();
  await job.progress(75);

  // 完成
  await job.progress(100);
  return result;
}
```

**前端轮询进度**：

```typescript
async getJobProgress(jobId: string) {
  const job = await this.queue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress = job.progress();

  return { state, progress };
}
```

### 4. 并发控制

**原则**：
- CPU 密集型任务：并发数 = CPU 核心数
- I/O 密集型任务（网络请求）：并发数可适当提高
- 外部 API 调用：根据 API 限流设置

```typescript
// 消息处理（I/O 密集）
this.messageQueue.process('process', 4, handler);

// Agent API 测试（外部 API 调用，耗时长）
this.testQueue.process('execute-test', 3, handler);
```

### 5. 失败处理

**区分重试失败和最终失败**：

```typescript
this.queue.on('failed', (job: Job, error: Error) => {
  const attemptsMade = job.attemptsMade;
  const maxAttempts = job.opts.attempts || 1;
  const isFinalAttempt = attemptsMade >= maxAttempts;

  if (isFinalAttempt) {
    // 最终失败：记录日志、发送告警、更新统计
    this.logger.error(`❌ 任务最终失败: ${job.id}`);
    this.updateStats({ status: 'FAILURE' });
  } else {
    // 重试失败：只记录日志
    this.logger.warn(`⚠️ 任务失败将重试 (${attemptsMade}/${maxAttempts})`);
  }
});
```

### 6. 完成判断策略

**问题**：使用缓存计数可能因竞态条件不准确。

**解决方案**：以数据库查询为准。

```typescript
// ❌ 错误：依赖 Redis 缓存计数
if (cache.completedCases >= totalCases) {
  // 可能因竞态条件导致判断错误
}

// ✅ 正确：查询数据库
const dbStats = await this.testSuiteService.countCompletedExecutions(batchId);
if (dbStats.total >= totalCases) {
  // 准确
}
```

## 常见问题

### 1. 队列卡住（stalled）

**原因**：Worker 进程崩溃或任务超时。

**解决方案**：
- 设置合理的 `timeout`
- 监听 `stalled` 事件
- 定期清理卡住的任务

```typescript
async cleanStuckJobs() {
  const activeJobs = await this.queue.getActive();
  for (const job of activeJobs) {
    const jobAge = Date.now() - job.timestamp;
    if (jobAge >= 5 * 60 * 1000) { // 超过 5 分钟
      await job.moveToFailed(new Error('任务卡住'), true);
      await job.remove();
    }
  }
}
```

### 2. Redis 连接问题

**症状**：`bclient.status` 未就绪导致任务无法添加。

**解决方案**：等待 `bclient` 就绪。

```typescript
private async waitForBclientReady(): Promise<void> {
  const queue = this.queue as any;
  const maxWaitTime = 30000;
  const checkInterval = 100;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const checkBclient = () => {
      const bclientStatus = queue.bclient?.status;

      if (bclientStatus === 'ready') {
        resolve();
        return;
      }

      if (Date.now() - startTime > maxWaitTime) {
        this.logger.warn('bclient 连接超时，继续运行');
        resolve();
        return;
      }

      setTimeout(checkBclient, checkInterval);
    };

    checkBclient();
  });
}
```

### 3. 任务无法取消

**原因**：正在执行的任务无法立即停止（Agent API 调用已发出）。

**解决方案**：使用 `job.discard()` 标记任务被丢弃。

```typescript
const activeJobs = await this.queue.getActive();
for (const job of activeJobs) {
  if (shouldCancel(job)) {
    await job.discard(); // 完成后不触发 completed 事件
  }
}
```

## 相关文档

- [Bull 官方文档](https://github.com/OptimalBits/bull)
- [NestJS Bull 文档](https://docs.nestjs.com/techniques/queues)
- [场景测试工作流程](../workflows/scenario-test-workflow.md)
- [对话验证工作流程](../workflows/conversation-test-workflow.md)
- [测试套件架构设计](../architecture/test-suite-architecture.md)
