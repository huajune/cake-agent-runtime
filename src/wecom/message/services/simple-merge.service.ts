import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { RedisService } from '@core/redis';
import { AgentReplyConfig } from '@db';
import { SystemConfigService } from '@biz/hosting-config/system-config.service';
import { EnterpriseMessageCallbackDto } from '../dto/message-callback.dto';
import { RedisKeyBuilder } from '../utils/redis-key.util';

/**
 * 简化版消息聚合服务
 *
 * 设计原则：
 * - 无状态：不维护复杂的会话状态机
 * - 利用 Bull Queue 原生能力：jobId 去重 + delay 聚合
 * - 消息存储在 Redis List 中，Worker 处理时获取
 *
 * 流程：
 * 1. 消息到达 → 存入 Redis List (wecom:message:pending:{chatId})
 * 2. 添加/更新 Bull 延迟任务 (jobId=chatId, delay=2s)
 * 3. 相同 chatId 的任务会被覆盖，延迟重新计时
 * 4. 2秒后 Worker 获取所有待处理消息，合并处理
 */
@Injectable()
export class SimpleMergeService implements OnModuleInit {
  private readonly logger = new Logger(SimpleMergeService.name);

  // Redis 配置
  private readonly PENDING_TTL_SECONDS = 300; // 5分钟过期兜底

  // 配置参数（支持动态更新）
  private mergeDelayMs = 2000; // 聚合等待时间
  private maxMergedMessages = 5; // 最多聚合消息数

  constructor(
    private readonly redisService: RedisService,
    private readonly systemConfigService: SystemConfigService,
    @InjectQueue('message-merge') private readonly messageQueue: Queue,
  ) {
    // 注册配置变更回调
    this.systemConfigService.onAgentReplyConfigChange((config) => {
      this.onConfigChange(config);
    });
  }

  async onModuleInit() {
    // 从 Supabase 加载动态配置
    try {
      const config = await this.systemConfigService.getAgentReplyConfig();
      this.mergeDelayMs = config.initialMergeWindowMs || 2000;
      this.maxMergedMessages = config.maxMergedMessages || 5;
      this.logger.log(
        `SimpleMergeService 已初始化: 聚合延迟=${this.mergeDelayMs}ms, 最大消息数=${this.maxMergedMessages}`,
      );
    } catch (error) {
      this.logger.warn(`加载配置失败，使用默认值: ${error.message}`);
    }
  }

  /**
   * 配置变更回调
   */
  private onConfigChange(config: AgentReplyConfig): void {
    const oldDelay = this.mergeDelayMs;
    const oldMax = this.maxMergedMessages;

    this.mergeDelayMs = config.initialMergeWindowMs || 2000;
    this.maxMergedMessages = config.maxMergedMessages || 5;

    if (oldDelay !== this.mergeDelayMs || oldMax !== this.maxMergedMessages) {
      this.logger.log(
        `配置已更新: 聚合延迟=${oldDelay}→${this.mergeDelayMs}ms, 最大消息数=${oldMax}→${this.maxMergedMessages}`,
      );
    }
  }

  /**
   * 添加消息到聚合队列
   * 这是外部调用的主入口
   */
  async addMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const chatId = messageData.chatId;
    const pendingKey = RedisKeyBuilder.pending(chatId);

    // 1. 将消息追加到 Redis List
    await this.redisService.rpush(pendingKey, JSON.stringify(messageData));
    await this.redisService.expire(pendingKey, this.PENDING_TTL_SECONDS);

    // 2. 检查当前队列长度
    const queueLength = await this.redisService.llen(pendingKey);

    this.logger.debug(`[${chatId}] 消息已加入聚合队列，当前队列长度: ${queueLength}`);

    // 3. 添加/更新延迟任务
    try {
      // 先检查是否存在任务
      const existingJob = await this.messageQueue.getJob(chatId);
      let jobId = chatId; // 默认使用 chatId 作为 jobId

      if (existingJob) {
        const state = await existingJob.getState();

        if (state === 'waiting' || state === 'delayed') {
          // 等待中或延迟中的任务：移除后重新创建（延迟重新计时）
          await existingJob.remove();
          this.logger.debug(`[${chatId}] 已移除旧的延迟任务 (state=${state})`);
        } else if (state === 'active') {
          // 正在处理中的任务：使用唯一 jobId 创建新任务
          // 这样新消息会在当前任务完成后立即处理
          jobId = `${chatId}:pending:${Date.now()}`;
          this.logger.debug(`[${chatId}] 现有任务正在处理中，使用新 jobId: ${jobId}`);
        }
        // 其他状态（completed/failed）不需要特殊处理，可以直接创建新任务
      }

      // 决定是否立即执行还是延迟执行
      let delay = this.mergeDelayMs;

      // 如果队列已满，立即执行
      if (queueLength >= this.maxMergedMessages) {
        delay = 0;
        this.logger.log(
          `[${chatId}] 队列已满 (${queueLength}/${this.maxMergedMessages})，立即处理`,
        );
      }

      // 添加新任务
      await this.messageQueue.add(
        'process',
        { chatId },
        {
          jobId,
          delay,
          removeOnComplete: true,
          removeOnFail: false, // 失败时保留用于调试
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );

      if (delay > 0) {
        this.logger.debug(`[${chatId}] 延迟任务已创建 (jobId=${jobId})，${delay}ms 后执行`);
      }
    } catch (error) {
      this.logger.error(`[${chatId}] 创建延迟任务失败: ${error.message}`);
      // 即使任务创建失败，消息已经在 Redis 中，不会丢失
      // 下一条消息到达时会再次尝试创建任务
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

    // 清空队列
    await this.redisService.del(pendingKey);

    // 解析消息
    const messages: EnterpriseMessageCallbackDto[] = [];
    for (const raw of rawMessages) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        messages.push(parsed as EnterpriseMessageCallbackDto);
      } catch (error) {
        this.logger.error(`[${chatId}] 解析消息失败: ${error.message}`);
      }
    }

    // 生成批次ID（格式：batch_{chatId}_{timestamp}）
    const batchId = `batch_${chatId}_${Date.now()}`;

    this.logger.log(`[${chatId}] 获取到 ${messages.length} 条待处理消息, batchId=${batchId}`);
    return { messages, batchId };
  }

  /**
   * 检查是否有新消息（Agent 处理完后调用）
   * 如果有新消息，创建一个立即执行的任务
   */
  async checkAndProcessNewMessages(chatId: string): Promise<boolean> {
    const pendingKey = RedisKeyBuilder.pending(chatId);
    const queueLength = await this.redisService.llen(pendingKey);

    if (queueLength === 0) {
      return false;
    }

    this.logger.log(`[${chatId}] Agent 处理完后发现 ${queueLength} 条新消息，创建立即处理任务`);

    // 创建立即执行的任务
    try {
      // 使用新的 jobId 避免与正在完成的任务冲突
      const newJobId = `${chatId}:retry:${Date.now()}`;
      await this.messageQueue.add(
        'process',
        { chatId },
        {
          jobId: newJobId,
          delay: 0, // 立即执行
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
      this.logger.error(`[${chatId}] 创建重试任务失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      mergeDelayMs: this.mergeDelayMs,
      maxMergedMessages: this.maxMergedMessages,
    };
  }
}
