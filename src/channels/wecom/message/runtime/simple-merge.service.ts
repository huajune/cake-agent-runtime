import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RedisService } from '@infra/redis/redis.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { RedisKeyBuilder } from './redis-key.util';
import { MessageRuntimeConfigService } from './message-runtime-config.service';

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

  constructor(
    private readonly redisService: RedisService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${chatId}] 创建延迟任务失败: ${errorMessage}`);
      // 即使任务创建失败，消息已经在 Redis 中，不会丢失；下一条消息会再次创建检查任务
    }
  }

  /**
   * 获取并清空待处理消息（供 Worker 调用）
   * 使用原子操作确保不会重复处理
   * @returns 消息列表和批次ID
   */
  async getAndClearPendingMessages(
    chatId: string,
  ): Promise<{ messages: EnterpriseMessageCallbackDto[]; batchId: string }> {
    const pendingKey = RedisKeyBuilder.pending(chatId);

    // 获取所有待处理消息
    const rawMessages = await this.redisService.lrange<string>(pendingKey, 0, -1);

    if (!rawMessages || rawMessages.length === 0) {
      this.logger.debug(`[${chatId}] 待处理队列为空（可能已被其他 Worker 处理）`);
      return { messages: [], batchId: '' };
    }

    // 只裁剪掉本次读取到的消息，保留消费期间新追加的消息
    await this.redisService.ltrim(pendingKey, rawMessages.length, -1);

    // 解析消息
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

    // 生成批次ID（格式：batch_{chatId}_{timestamp}）
    const batchId = `batch_${chatId}_${Date.now()}`;

    this.logger.log(`[${chatId}] 获取到 ${messages.length} 条待处理消息, batchId=${batchId}`);
    return { messages, batchId };
  }

  async acquireProcessingLock(chatId: string, ownerToken: string): Promise<boolean> {
    const result = await this.redisService
      .getClient()
      .set(RedisKeyBuilder.lock(chatId), ownerToken, {
        nx: true,
        ex: this.PROCESSING_LOCK_TTL_SECONDS,
      });

    return result === 'OK';
  }

  async releaseProcessingLock(chatId: string, ownerToken: string): Promise<void> {
    await this.redisService.getClient().eval(
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
