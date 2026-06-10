import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RedisService } from '@infra/redis/redis.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { RedisKeyBuilder } from './redis-key.util';
import { MessageRuntimeConfigService } from './message-runtime-config.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';

/**
 * 简化版消息聚合服务
 *
 * 设计原则：
 * - 基于“最后一条消息后的静默窗口”做 debounce 聚合
 * - 不维护复杂会话状态机，也不使用“队列满立即处理”这类额外分支
 * - 消息存储在 Redis List 中，Worker 处理时按静默窗口决定是否真正触发 Agent
 *
 * 流程：
 * 1. 消息到达 → 存入 Redis List (wecom:message:pending:{chatId})
 * 2. 记录本会话“最后一条消息时间”
 * 3. 每条消息都创建一个延迟检查任务（delay=静默窗口）
 * 4. Worker 执行时，只有当“距离最后一条消息已静默足够久”才真正取出并处理本轮消息
 */
@Injectable()
export class SimpleMergeService implements OnModuleInit {
  private readonly logger = new Logger(SimpleMergeService.name);

  // Redis 配置
  private readonly PENDING_TTL_SECONDS = 300; // 5分钟过期兜底
  private readonly PROCESSING_LOCK_TTL_SECONDS = 300;
  private readonly QUIET_WINDOW_FOLLOWUP_DELAY_MS = 200;
  private readonly LOCK_RETRY_DELAY_MS = 30000;

  constructor(
    private readonly redisService: RedisService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    @InjectQueue('message-merge') private readonly messageQueue: Queue,
  ) {}

  async onModuleInit() {
    this.logger.log(
      `SimpleMergeService 已初始化: 静默窗口=${this.runtimeConfig.getMergeDelayMs()}ms`,
    );
  }

  /**
   * 添加消息到聚合队列
   * 这是外部调用的主入口
   */
  async addMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    await this.runtimeConfig.syncSnapshot();

    const chatId = messageData.chatId;
    const pendingKey = RedisKeyBuilder.pending(chatId);
    const lastMessageAt = Date.now();
    const mergeDelayMs = this.runtimeConfig.getMergeDelayMs();

    // 1. 将消息追加到 Redis List
    await this.redisService.rpush(pendingKey, JSON.stringify(messageData));
    await this.redisService.expire(pendingKey, this.PENDING_TTL_SECONDS);
    await this.redisService.setex(
      RedisKeyBuilder.lastMessageAt(chatId),
      this.PENDING_TTL_SECONDS,
      String(lastMessageAt),
    );

    // 2. 仅用于观测当前待处理队列长度
    const queueLength = await this.redisService.llen(pendingKey);

    this.logger.debug(`[${chatId}] 消息已加入聚合队列，当前队列长度: ${queueLength}`);

    // 3. 为本条消息创建一次“静默窗口检查”任务
    try {
      await this.messageQueue.add(
        'process',
        { chatId },
        {
          jobId: `${chatId}:${messageData.messageId}`,
          delay: mergeDelayMs,
          removeOnComplete: true,
          removeOnFail: false, // 失败时保留用于调试
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );
      this.logger.debug(
        `[${chatId}] 静默窗口检查任务已创建，jobId=${chatId}:${messageData.messageId}, delay=${mergeDelayMs}ms`,
      );
      await this.wecomObservability.markQueueAdd(messageData.messageId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${chatId}] 创建延迟任务失败: ${errorMessage}`);
      // 即使任务创建失败，消息已经在 Redis 中，不会丢失；下一条消息会再次创建检查任务
    }
  }

  /**
   * 抓取 pending 列表当前快照（不从队列中移除）。
   *
   * 与旧的 `getAndClearPendingMessages` 区别：本方法只 LRANGE，不 LTRIM。处理成功后由
   * 调用方显式调用 `ackPendingMessages` 将已消费的部分裁掉。这样进程被发版 SIGKILL
   * 中断时，pending 中的消息保持原样，Bull stalled retry 拉起的新 worker 仍能拿到
   * 完整数据继续处理，避免候选人消息因部署被吞。
   *
   * @param fromIndex 起始索引。Worker 初次抓取传 0；agent 执行期间补抓新消息（replay
   *                  路径）传上一次的 snapshotSize，避免与初次快照重叠。
   * @returns messages 解析后的消息；snapshotSize 本次抓取到的原始条数（含解析失败项，
   *          用于 ack 时的 LTRIM 偏移）；batchId 仅在 fromIndex===0 时生成。
   */
  async claimPendingSnapshot(
    chatId: string,
    fromIndex = 0,
  ): Promise<{ messages: EnterpriseMessageCallbackDto[]; snapshotSize: number; batchId: string }> {
    const pendingKey = RedisKeyBuilder.pending(chatId);

    const rawMessages = await this.redisService.lrange<string>(pendingKey, fromIndex, -1);

    if (!rawMessages || rawMessages.length === 0) {
      if (fromIndex === 0) {
        this.logger.debug(`[${chatId}] 待处理队列为空（可能已被其他 Worker 处理）`);
      }
      return { messages: [], snapshotSize: 0, batchId: '' };
    }

    const messages: EnterpriseMessageCallbackDto[] = [];
    for (const raw of rawMessages) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        messages.push(parsed as EnterpriseMessageCallbackDto);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`[${chatId}] 解析消息失败: ${errorMessage}`);
      }
    }

    const batchId = fromIndex === 0 ? `batch_${chatId}_${Date.now()}` : '';

    if (batchId) {
      this.logger.log(`[${chatId}] 读取 ${messages.length} 条待处理消息, batchId=${batchId}`);
    } else {
      this.logger.log(`[${chatId}] 补抓 ${messages.length} 条 pending（fromIndex=${fromIndex}）`);
    }

    return { messages, snapshotSize: rawMessages.length, batchId };
  }

  /**
   * 确认已处理的 pending 消息，从队首裁掉 `count` 条。
   *
   * 必须在 agent 调用 + 投递全部成功后调用一次（聚合传 snap1Size + replay snap2Size）。
   * 投递前进程被 kill 时调用方应跳过 ack，让 pending 保持原样以供 Bull stalled retry
   * 拉起的新 worker 重放。
   */
  async ackPendingMessages(chatId: string, count: number): Promise<void> {
    if (count <= 0) return;
    const pendingKey = RedisKeyBuilder.pending(chatId);
    await this.redisService.ltrim(pendingKey, count, -1);
    this.logger.debug(`[${chatId}] ack 已处理 ${count} 条 pending`);
  }

  async acquireProcessingLock(chatId: string, ownerToken: string): Promise<boolean> {
    return this.redisService.setNx(
      RedisKeyBuilder.lock(chatId),
      ownerToken,
      this.PROCESSING_LOCK_TTL_SECONDS,
    );
  }

  /**
   * 锁冲突时的兜底重检。
   *
   * 正常情况下锁由同 chat 的另一个存活 worker 持有，它处理完会自查新消息，
   * 冲突任务静默跳过是安全的。但持锁进程被发版重启杀死时，锁会孤悬到 TTL
   * 过期（最长 PROCESSING_LOCK_TTL_SECONDS），期间所有检查任务若只是跳过，
   * pending 会跟着自身 TTL 过期、消息永久丢失（2026-06-09 v5.13.0 发版事故）。
   *
   * 这里做两件事：
   * 1. 续期 pending / lastMessageAt，保证消息能活到孤悬锁过期之后；
   * 2. 补建一个延迟重检任务（按时间桶去重，同窗口内只建一个），锁过期后接手处理。
   */
  async scheduleLockRetryCheck(chatId: string): Promise<void> {
    try {
      const pendingKey = RedisKeyBuilder.pending(chatId);
      const queueLength = await this.redisService.llen(pendingKey);
      if (queueLength === 0) {
        return;
      }

      await this.redisService.expire(pendingKey, this.PENDING_TTL_SECONDS);
      await this.redisService.expire(
        RedisKeyBuilder.lastMessageAt(chatId),
        this.PENDING_TTL_SECONDS,
      );

      const bucket = Math.floor(Date.now() / this.LOCK_RETRY_DELAY_MS);
      await this.messageQueue.add(
        'process',
        { chatId },
        {
          jobId: `${chatId}:lockretry:${bucket}`,
          delay: this.LOCK_RETRY_DELAY_MS,
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );
      this.logger.debug(
        `[${chatId}] 锁冲突，已补建重检任务（delay=${this.LOCK_RETRY_DELAY_MS}ms, pending=${queueLength}）`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${chatId}] 创建锁冲突重检任务失败: ${errorMessage}`);
    }
  }

  async releaseProcessingLock(chatId: string, ownerToken: string): Promise<void> {
    await this.redisService.eval(
      `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          end
          return 0
        `,
      [RedisKeyBuilder.lock(chatId)],
      [ownerToken],
    );
  }

  /**
   * 检查是否有新消息（Agent 处理完后调用）
   * 如果有新消息，则按照“最后一条消息后的静默窗口”补建下一轮检查任务
   */
  async checkAndProcessNewMessages(chatId: string): Promise<boolean> {
    const pendingKey = RedisKeyBuilder.pending(chatId);
    const queueLength = await this.redisService.llen(pendingKey);

    if (queueLength === 0) {
      return false;
    }

    const remainingDelayMs = await this.getRemainingQuietWindowMs(chatId);
    const scheduledDelayMs =
      remainingDelayMs > 0 ? remainingDelayMs : this.QUIET_WINDOW_FOLLOWUP_DELAY_MS;

    this.logger.log(
      `[${chatId}] Agent 处理完后发现 ${queueLength} 条新消息，按静默窗口补建 follow-up 任务，delay=${scheduledDelayMs}ms`,
    );

    try {
      const newJobId = `${chatId}:followup:${Date.now()}`;
      await this.messageQueue.add(
        'process',
        { chatId },
        {
          jobId: newJobId,
          delay: scheduledDelayMs,
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${chatId}] 创建重试任务失败: ${errorMessage}`);
      return false;
    }
  }

  async isQuietWindowElapsed(chatId: string): Promise<boolean> {
    const remainingDelayMs = await this.getRemainingQuietWindowMs(chatId);
    return remainingDelayMs <= 0;
  }

  private async getRemainingQuietWindowMs(chatId: string): Promise<number> {
    await this.runtimeConfig.syncSnapshot();

    const rawValue = await this.redisService.get<string>(RedisKeyBuilder.lastMessageAt(chatId));
    const lastMessageAt = Number(rawValue);
    const mergeDelayMs = this.runtimeConfig.getMergeDelayMs();

    if (!Number.isFinite(lastMessageAt) || lastMessageAt <= 0) {
      return 0;
    }

    const idleMs = Date.now() - lastMessageAt;
    return Math.max(mergeDelayMs - idleMs, 0);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      mergeDelayMs: this.runtimeConfig.getMergeDelayMs(),
    };
  }
}
