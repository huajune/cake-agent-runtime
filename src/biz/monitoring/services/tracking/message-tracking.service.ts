import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  MessageProcessingRecord,
  MonitoringMetadata,
  MonitoringErrorLog,
  MonitoringGlobalCounters,
  AlertErrorType,
} from '@shared-types/tracking.types';
import { MonitoringCacheService } from './monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

/**
 * 消息追踪服务
 * 负责消息处理生命周期的记录与追踪
 *
 * 职责：
 * - 记录消息接收、Worker 开始、AI 开始/结束、发送开始/结束
 * - 记录成功/失败状态
 * - 管理 pendingRecords（内存中未完成的消息）
 * - 更新 Redis 计数器和活跃用户/会话
 * - 保存记录到数据库
 */
@Injectable()
export class MessageTrackingService implements OnModuleDestroy {
  private readonly logger = new Logger(MessageTrackingService.name);

  // 临时记录存储（仅保留未完成的消息，完成后写入数据库）
  private pendingRecords = new Map<string, MessageProcessingRecord>();

  // 定期清理超过 1 小时的临时记录（防止内存泄漏）
  private readonly PENDING_RECORD_TTL_MS = 60 * 60 * 1000; // 1 小时
  /** 周期清理 pendingRecords 的定时器，模块销毁时需要回收。 */
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly userHostingService: UserHostingService,
    private readonly cacheService: MonitoringCacheService,
  ) {}

  onModuleInit(): void {
    // 定期清理超时的临时记录（每10分钟执行一次）
    this.cleanupTimer = setInterval(() => this.cleanupPendingRecords(), 10 * 60 * 1000);
    this.cleanupTimer.unref?.();
    this.logger.log('消息追踪服务已启动');
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 获取当前处理中的消息数
   */
  getPendingCount(): number {
    return this.pendingRecords.size;
  }

  /**
   * 记录消息接收
   */
  recordMessageReceived(
    messageId: string,
    chatId: string,
    userId?: string,
    userName?: string,
    messageContent?: string,
    metadata?: MonitoringMetadata,
    managerName?: string,
    receivedAt?: number,
  ): void {
    const now = receivedAt && Number.isFinite(receivedAt) ? receivedAt : Date.now();
    const record: MessageProcessingRecord = {
      messageId,
      chatId,
      userId,
      userName,
      managerName,
      receivedAt: now,
      status: 'processing',
      messagePreview: messageContent ? messageContent.substring(0, 50) : undefined,
      scenario: metadata?.scenario,
    };

    // 存入临时记录
    this.pendingRecords.set(messageId, record);
    this.logger.debug(
      `[recordMessageReceived] 已创建临时记录 [${messageId}], pendingRecords size=${this.pendingRecords.size}`,
    );

    // 立即保存 processing 状态到数据库（用户可见处理中的消息）
    this.saveRecordToDatabase(record).catch((err) => {
      this.logger.warn(`保存 processing 状态到数据库失败 (messageId: ${messageId}):`, err);
    });

    // 更新 Redis 缓存
    this.cacheService.incrementCounter('totalMessages', 1).catch((err) => {
      this.logger.warn('更新 totalMessages 计数器失败:', err);
    });

    // 更新并发统计
    this.cacheService
      .incrementCurrentProcessing(1)
      .then((newValue) => this.cacheService.updatePeakProcessing(newValue))
      .catch((err) => this.logger.warn('更新峰值处理数失败:', err));

    // 立即写入 user_activity 表（消息接收时就记录，不等处理完成）
    this.saveUserActivity({
      chatId,
      userId,
      userName,
      messageCount: 1,
      tokenUsage: 0,
      activeAt: now,
    }).catch((err) => {
      this.logger.warn(`记录用户活动失败 [${messageId}]:`, err);
    });

    this.logger.log(
      `[Monitoring] 记录消息接收 [${messageId}], chatId=${chatId}, scenario=${metadata?.scenario ?? 'unknown'}`,
    );
  }

  /**
   * 记录 Worker 开始处理（用于计算真正的队列等待时间）
   */
  recordWorkerStart(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record) {
      const now = Date.now();
      record.queueDuration = now - record.receivedAt;
      this.logger.debug(`记录 Worker 开始处理 [${messageId}], queue=${record.queueDuration}ms`);
    }
  }

  /**
   * 记录 AI 处理开始
   */
  recordAiStart(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record) {
      const now = Date.now();
      record.aiStartAt = now;

      if (record.queueDuration !== undefined) {
        const workerStartAt = record.receivedAt + record.queueDuration;
        record.prepDuration = now - workerStartAt;
        this.logger.debug(`记录 AI 开始处理 [${messageId}], prep=${record.prepDuration}ms`);
      } else {
        record.queueDuration = now - record.receivedAt;
        this.logger.debug(
          `记录 AI 开始处理 [${messageId}], queue=${record.queueDuration}ms (legacy)`,
        );
      }
    }
  }

  /**
   * 记录 AI 处理完成
   */
  recordAiEnd(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record && record.aiStartAt) {
      record.aiEndAt = Date.now();
      record.aiDuration = record.aiEndAt - record.aiStartAt;

      this.cacheService.incrementCounter('totalAiDuration', record.aiDuration).catch((err) => {
        this.logger.warn('更新 totalAiDuration 计数器失败:', err);
      });

      this.logger.debug(`记录 AI 完成处理 [${messageId}], 耗时: ${record.aiDuration}ms`);
    }
  }

  /**
   * 记录消息发送开始
   */
  recordSendStart(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record) {
      record.sendStartAt = Date.now();
      this.logger.debug(`记录消息发送开始 [${messageId}]`);
    }
  }

  /**
   * 记录消息发送完成
   */
  recordSendEnd(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record && record.sendStartAt) {
      record.sendEndAt = Date.now();
      record.sendDuration = record.sendEndAt - record.sendStartAt;

      this.cacheService.incrementCounter('totalSendDuration', record.sendDuration).catch((err) => {
        this.logger.warn('更新 totalSendDuration 计数器失败:', err);
      });

      this.logger.debug(`记录消息发送完成 [${messageId}], 耗时: ${record.sendDuration}ms`);
    }
  }

  /**
   * 记录消息处理成功
   */
  recordSuccess(
    messageId: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.logger.debug(
      `[recordSuccess] 开始处理 [${messageId}], pendingRecords size=${this.pendingRecords.size}`,
    );

    const record = this.pendingRecords.get(messageId);

    if (!record) {
      this.logger.warn(
        `[recordSuccess] 临时记录未找到 [${messageId}]（可能因服务重启丢失），直接更新数据库`,
      );
      // 降级：直接更新数据库，避免记录永远卡在 processing 状态
      this.directUpdateStatus(messageId, 'success', metadata).catch((err) => {
        this.logger.error(`[recordSuccess] 直接更新数据库失败 [${messageId}]:`, err);
      });
      return;
    }

    // 更新记录状态
    record.status = 'success';
    record.totalDuration = Date.now() - record.receivedAt;
    record.scenario = metadata?.scenario || record.scenario;
    record.tools = metadata?.tools || record.tools;
    record.tokenUsage = metadata?.tokenUsage ?? record.tokenUsage;
    record.replyPreview = metadata?.replyPreview ?? record.replyPreview;
    record.replySegments = metadata?.replySegments ?? record.replySegments;
    record.isFallback = metadata?.isFallback ?? record.isFallback;
    record.fallbackSuccess = metadata?.fallbackSuccess ?? record.fallbackSuccess;
    record.agentInvocation = metadata?.agentInvocation ?? record.agentInvocation;
    record.batchId = metadata?.batchId ?? record.batchId;

    // 更新 Redis 计数器
    const counterUpdates: Partial<MonitoringGlobalCounters> = { totalSuccess: 1 };
    if (record.isFallback) {
      counterUpdates.totalFallback = 1;
      if (record.fallbackSuccess) {
        counterUpdates.totalFallbackSuccess = 1;
      }
    }

    this.cacheService.incrementCounters(counterUpdates).catch((err) => {
      this.logger.warn('更新成功计数器失败:', err);
    });

    // 减少当前处理数
    this.cacheService.incrementCurrentProcessing(-1).catch((err) => {
      this.logger.warn('减少当前处理数失败:', err);
    });

    this.logger.log(
      `消息处理成功 [${messageId}], 总耗时: ${record.totalDuration}ms, scenario=${
        record.scenario || 'unknown'
      }, fallback=${record.isFallback ? 'true' : 'false'}`,
    );

    // 异步写入数据库（不阻塞主流程）
    this.saveRecordToDatabase(record)
      .catch((err) => {
        this.logger.error(`保存消息处理记录到数据库失败 [${messageId}]:`, err);
      })
      .finally(() => {
        this.pendingRecords.delete(messageId);
        this.logger.debug(
          `[recordSuccess] 已删除临时记录 [${messageId}], pendingRecords size=${this.pendingRecords.size}`,
        );
      });

    // 更新 user_activity 的 tokenUsage
    if (record.tokenUsage && record.tokenUsage > 0) {
      this.saveUserActivity({
        chatId: record.chatId,
        userId: record.userId,
        userName: record.userName,
        messageCount: 0,
        tokenUsage: record.tokenUsage,
        activeAt: record.receivedAt,
      }).catch((err) => {
        this.logger.warn(`更新用户 Token 消耗失败 [${messageId}]:`, err);
      });
    }
  }

  /**
   * 记录消息处理失败
   */
  recordFailure(
    messageId: string,
    error: string,
    metadata?: MonitoringMetadata & {
      fallbackSuccess?: boolean;
      batchId?: string;
    },
  ): void {
    this.logger.debug(`[recordFailure] 开始处理 [${messageId}]`);

    const record = this.pendingRecords.get(messageId);

    if (!record) {
      this.logger.warn(
        `[recordFailure] 临时记录未找到 [${messageId}]（可能因服务重启丢失），直接更新数据库`,
      );
      this.saveErrorLog(messageId, error, metadata?.alertType);
      // 降级：直接更新数据库，避免记录永远卡在 processing 状态
      this.directUpdateStatus(messageId, 'failure', metadata, error).catch((err) => {
        this.logger.error(`[recordFailure] 直接更新数据库失败 [${messageId}]:`, err);
      });
      return;
    }

    // 更新记录状态
    record.status = 'failure';
    record.error = error;
    record.totalDuration = Date.now() - record.receivedAt;
    record.scenario = metadata?.scenario || record.scenario;
    record.tools = metadata?.tools || record.tools;
    record.tokenUsage = metadata?.tokenUsage ?? record.tokenUsage;
    record.replySegments = metadata?.replySegments ?? record.replySegments;
    record.isFallback = metadata?.isFallback ?? record.isFallback;
    record.fallbackSuccess = metadata?.fallbackSuccess ?? record.fallbackSuccess;
    record.alertType = metadata?.alertType ?? record.alertType;
    record.agentInvocation = metadata?.agentInvocation ?? record.agentInvocation;
    record.batchId = metadata?.batchId ?? record.batchId;

    // 更新 Redis 计数器
    const counterUpdates: Partial<MonitoringGlobalCounters> = { totalFailure: 1 };
    if (record.isFallback) {
      counterUpdates.totalFallback = 1;
      if (record.fallbackSuccess) {
        counterUpdates.totalFallbackSuccess = 1;
      }
    }

    this.cacheService.incrementCounters(counterUpdates).catch((err) => {
      this.logger.warn('更新失败计数器失败:', err);
    });

    // 减少当前处理数
    this.cacheService.incrementCurrentProcessing(-1).catch((err) => {
      this.logger.warn('减少当前处理数失败:', err);
    });

    // 添加到错误日志
    this.saveErrorLog(messageId, error, record.alertType);

    this.logger.error(
      `消息处理失败 [${messageId}]: ${error}, scenario=${record.scenario || 'unknown'}, alertType=${record.alertType || 'unknown'}, fallback=${record.isFallback ? 'true' : 'false'}`,
    );

    // 异步写入数据库（不阻塞主流程）
    this.saveRecordToDatabase(record)
      .catch((err) => {
        this.logger.error(`保存失败消息处理记录到数据库失败 [${messageId}]:`, err);
      })
      .finally(() => {
        this.pendingRecords.delete(messageId);
      });
  }

  // ========== 私有方法 ==========

  /**
   * 降级路径：pendingRecords 丢失时，直接按 message_id 更新 DB 状态
   * 解决服务重启后 in-memory pendingRecords 丢失导致记录永远卡在 processing 的问题
   */
  private async directUpdateStatus(
    messageId: string,
    status: 'success' | 'failure',
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
    error?: string,
  ): Promise<void> {
    await this.withRetry(() =>
      this.messageProcessingService.updateStatusByMessageId(messageId, {
        status,
        error,
        scenario: metadata?.scenario,
        tokenUsage: metadata?.tokenUsage,
        replyPreview: metadata?.replyPreview,
        replySegments: metadata?.replySegments,
        isFallback: metadata?.isFallback,
        fallbackSuccess: metadata?.fallbackSuccess,
        batchId: metadata?.batchId,
      }),
    );
    this.logger.log(`[directUpdateStatus] 已直接更新数据库 [${messageId}] → ${status}`);
  }

  /**
   * 带指数退避重试的包装器（最多 retries 次，初始延迟 delayMs）
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    retries: number = 2,
    delayMs: number = 500,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (retries <= 0) throw error;
      await new Promise((r) => setTimeout(r, delayMs));
      return this.withRetry(fn, retries - 1, delayMs * 2);
    }
  }

  /**
   * 保存消息处理记录到数据库（带重试）
   */
  private async saveRecordToDatabase(record: MessageProcessingRecord): Promise<void> {
    await this.withRetry(() =>
      this.messageProcessingService.saveRecord({
        messageId: record.messageId,
        chatId: record.chatId,
        userId: record.userId,
        userName: record.userName,
        managerName: record.managerName,
        receivedAt: record.receivedAt,
        messagePreview: record.messagePreview,
        replyPreview: record.replyPreview,
        replySegments: record.replySegments,
        status: record.status,
        error: record.error,
        scenario: record.scenario,
        totalDuration: record.totalDuration,
        queueDuration: record.queueDuration,
        prepDuration: record.prepDuration,
        aiStartAt: record.aiStartAt,
        aiEndAt: record.aiEndAt,
        aiDuration: record.aiDuration,
        sendDuration: record.sendDuration,
        tools: record.tools,
        tokenUsage: record.tokenUsage,
        isFallback: record.isFallback,
        fallbackSuccess: record.fallbackSuccess,
        agentInvocation: record.agentInvocation,
        batchId: record.batchId,
      }),
    );
    this.logger.debug(`已保存消息处理记录到数据库 [${record.messageId}]`);
  }

  /**
   * 保存错误日志
   */
  private saveErrorLog(messageId: string, error: string, alertType?: AlertErrorType): void {
    const errorLog: MonitoringErrorLog = {
      messageId,
      timestamp: Date.now(),
      error,
      alertType: alertType || 'unknown',
    };

    this.withRetry(() => this.errorLogRepository.saveErrorLog(errorLog)).catch((err) => {
      this.logger.warn(`保存错误日志到数据库失败 [${messageId}]:`, err);
    });
  }

  /**
   * 保存用户活跃记录到 user_activity 表
   */
  private async saveUserActivity(data: {
    chatId: string;
    userId?: string;
    userName?: string;
    groupId?: string;
    groupName?: string;
    messageCount: number;
    tokenUsage: number;
    activeAt: number;
  }): Promise<void> {
    await this.withRetry(() =>
      this.userHostingService.upsertActivity({
        chatId: data.chatId,
        odId: data.userId,
        odName: data.userName,
        groupId: data.groupId,
        groupName: data.groupName,
        messageCount: data.messageCount,
        totalTokens: data.tokenUsage,
        activeAt: new Date(data.activeAt),
      }),
    );
    this.logger.debug(`[user_activity] 已更新用户活跃记录: ${data.chatId}`);
  }

  /**
   * 清理超时的临时记录（防止内存泄漏）
   */
  private cleanupPendingRecords(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [messageId, record] of this.pendingRecords.entries()) {
      if (now - record.receivedAt > this.PENDING_RECORD_TTL_MS) {
        record.status = 'failure';
        record.error = '超时未完成（1小时）';
        record.totalDuration = now - record.receivedAt;

        this.saveRecordToDatabase(record).catch((err) => {
          this.logger.warn(`保存超时记录失败 [${messageId}]:`, err);
        });

        this.pendingRecords.delete(messageId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.warn(`清理了 ${cleanedCount} 条超时的临时记录`);
    }
  }
}
