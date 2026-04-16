import { Injectable, Logger } from '@nestjs/common';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import {
  MonitoringMetadata,
  MonitoringErrorLog,
  MonitoringGlobalCounters,
  AlertErrorType,
} from '@shared-types/tracking.types';
import { MonitoringCacheService } from './monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

interface InvocationTimingSummary {
  timestamps: {
    acceptedAt?: number;
    aiStartAt?: number;
    aiEndAt?: number;
  };
  durations: {
    acceptedToWorkerStartMs?: number;
    workerStartToAiStartMs?: number;
    aiStartToAiEndMs?: number;
    deliveryDurationMs?: number;
    totalMs?: number;
  };
}

interface InvocationSnapshot {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  isFallback?: boolean;
}

/**
 * 消息追踪服务
 *
 * 设计说明：
 * - 请求开始时立即落一条 processing 记录，方便列表实时展示
 * - 请求执行中的权威生命周期状态由 Redis trace 维护
 * - 请求结束时从 agentInvocation/trace 快照还原完整记录，再 upsert 回库
 */
@Injectable()
export class MessageTrackingService {
  private readonly logger = new Logger(MessageTrackingService.name);

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly userHostingService: UserHostingService,
    private readonly cacheService: MonitoringCacheService,
  ) {}

  onModuleInit(): void {
    this.logger.log('消息追踪服务已启动');
  }

  /**
   * 获取当前在途请求数
   */
  async getActiveRequests(): Promise<number> {
    return this.cacheService.getActiveRequests();
  }

  /**
   * 获取运行期峰值在途请求数
   */
  async getPeakActiveRequests(): Promise<number> {
    return this.cacheService.getPeakActiveRequests();
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
    const record: MessageProcessingRecordInput = {
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

    this.cacheService.incrementActiveRequests(1).catch((err) => {
      this.logger.warn('更新 activeRequests 失败:', err);
    });

    // 立即保存 processing 状态到数据库（用户可见处理中的消息）
    this.saveRecordToDatabase(record).catch((err) => {
      this.logger.warn(`保存 processing 状态到数据库失败 (messageId: ${messageId}):`, err);
    });

    // 更新 Redis 缓存
    this.cacheService.incrementCounter('totalMessages', 1).catch((err) => {
      this.logger.warn('更新 totalMessages 计数器失败:', err);
    });

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
   * 生命周期阶段埋点由 Redis trace 维护。
   * 这些方法保留是为了兼容现有调用方，不再依赖进程内状态做拼装。
   */
  recordWorkerStart(_messageId: string): void {}

  recordAiStart(_messageId: string): void {}

  recordAiEnd(_messageId: string): void {}

  recordSendStart(_messageId: string): void {}

  recordSendEnd(_messageId: string): void {}

  /**
   * 记录消息处理成功
   */
  recordSuccess(
    messageId: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.logger.debug(`[recordSuccess] 开始处理 [${messageId}]`);
    void this.persistTerminalState({
      messageId,
      status: 'success',
      metadata,
    }).catch((err) => {
      this.logger.error(`保存消息处理记录到数据库失败 [${messageId}]:`, err);
    });
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
    this.saveErrorLog(messageId, error, metadata?.alertType);

    void this.persistTerminalState({
      messageId,
      status: 'failure',
      error,
      metadata,
    }).catch((err) => {
      this.logger.error(`保存失败消息处理记录到数据库失败 [${messageId}]:`, err);
    });
  }

  private async persistTerminalState(params: {
    messageId: string;
    status: 'success' | 'failure';
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean; batchId?: string };
    error?: string;
  }): Promise<void> {
    try {
      const existingRecord =
        await this.messageProcessingService.getMessageProcessingRecordById(params.messageId);
      const finalRecord = this.buildTerminalRecord({
        messageId: params.messageId,
        status: params.status,
        error: params.error,
        metadata: params.metadata,
        existingRecord,
      });

      if (!finalRecord) {
        this.logger.warn(
          `[record${params.status === 'success' ? 'Success' : 'Failure'}] 无法还原终态记录 [${params.messageId}]，跳过回写`,
        );
        return;
      }

      await this.applyTerminalCounters(finalRecord);

      this.logger.log(
        `消息处理${params.status === 'success' ? '成功' : '失败'} [${params.messageId}], 总耗时: ${
          finalRecord.totalDuration ?? 0
        }ms, scenario=${finalRecord.scenario || 'unknown'}, fallback=${
          finalRecord.isFallback ? 'true' : 'false'
        }`,
      );

      await this.saveRecordToDatabase(finalRecord);

      if (finalRecord.tokenUsage && finalRecord.tokenUsage > 0) {
        this.saveUserActivity({
          chatId: finalRecord.chatId,
          userId: finalRecord.userId,
          userName: finalRecord.userName,
          messageCount: 0,
          tokenUsage: finalRecord.tokenUsage,
          activeAt: finalRecord.receivedAt,
        }).catch((err) => {
          this.logger.warn(`更新用户 Token 消耗失败 [${params.messageId}]:`, err);
        });
      }
    } finally {
      await this.releaseActiveRequest(params.messageId);
    }
  }

  private async applyTerminalCounters(record: MessageProcessingRecordInput): Promise<void> {
    const counterUpdates: Partial<MonitoringGlobalCounters> =
      record.status === 'success' ? { totalSuccess: 1 } : { totalFailure: 1 };

    if (record.isFallback) {
      counterUpdates.totalFallback = 1;
      if (record.fallbackSuccess) {
        counterUpdates.totalFallbackSuccess = 1;
      }
    }

    const updates: Promise<unknown>[] = [
      this.cacheService.incrementCounters(counterUpdates).catch((err) => {
        this.logger.warn(`更新${record.status === 'success' ? '成功' : '失败'}计数器失败:`, err);
      }),
    ];

    if (record.aiDuration && record.aiDuration > 0) {
      updates.push(
        this.cacheService.incrementCounter('totalAiDuration', record.aiDuration).catch((err) => {
          this.logger.warn('更新 totalAiDuration 计数器失败:', err);
        }),
      );
    }

    if (record.sendDuration && record.sendDuration > 0) {
      updates.push(
        this.cacheService.incrementCounter('totalSendDuration', record.sendDuration).catch((err) => {
          this.logger.warn('更新 totalSendDuration 计数器失败:', err);
        }),
      );
    }

    await Promise.all(updates);
  }

  private buildTerminalRecord(params: {
    messageId: string;
    status: 'success' | 'failure';
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean; batchId?: string };
    error?: string;
    existingRecord?: MessageProcessingRecordInput | null;
  }): MessageProcessingRecordInput | null {
    const invocation = this.asInvocation(params.metadata?.agentInvocation ?? params.existingRecord?.agentInvocation);
    const request = this.asRecord(invocation?.request);
    const response = this.asRecord(invocation?.response);
    const reply = this.asRecord(response?.reply);
    const fallback = this.asRecord(response?.fallback);
    const timings = this.extractTimingSummary(response?.timings);

    const chatId = this.asString(request?.chatId) ?? params.existingRecord?.chatId;
    const receivedAt = this.firstNumber(
      this.asNumber(request?.acceptedAt),
      timings.timestamps.acceptedAt,
      params.existingRecord?.receivedAt,
    );

    if (!chatId || receivedAt === undefined) {
      return null;
    }

    const requestContent = this.asString(request?.content);
    const replyPreview =
      params.metadata?.replyPreview ??
      this.asString(reply?.content) ??
      params.existingRecord?.replyPreview;

    return {
      messageId: params.messageId,
      chatId,
      userId: this.asString(request?.userId) ?? params.existingRecord?.userId,
      userName: this.asString(request?.userName) ?? params.existingRecord?.userName,
      managerName: this.asString(request?.managerName) ?? params.existingRecord?.managerName,
      receivedAt,
      messagePreview: requestContent
        ? requestContent.substring(0, 50)
        : params.existingRecord?.messagePreview,
      replyPreview,
      replySegments:
        params.metadata?.replySegments ??
        this.asNumber(this.asRecord(response?.delivery)?.segmentCount) ??
        params.existingRecord?.replySegments,
      status: params.status,
      error: params.error ?? this.asString(response?.error) ?? params.existingRecord?.error,
      scenario:
        params.metadata?.scenario ??
        this.asString(request?.scenario) ??
        params.existingRecord?.scenario,
      totalDuration: timings.durations.totalMs ?? params.existingRecord?.totalDuration,
      // 顶层 queueDuration 继续保留旧语义：accepted -> workerStart 的整体等待
      queueDuration:
        timings.durations.acceptedToWorkerStartMs ?? params.existingRecord?.queueDuration,
      prepDuration:
        timings.durations.workerStartToAiStartMs ?? params.existingRecord?.prepDuration,
      aiStartAt: timings.timestamps.aiStartAt ?? params.existingRecord?.aiStartAt,
      aiEndAt: timings.timestamps.aiEndAt ?? params.existingRecord?.aiEndAt,
      aiDuration: timings.durations.aiStartToAiEndMs ?? params.existingRecord?.aiDuration,
      sendDuration: timings.durations.deliveryDurationMs ?? params.existingRecord?.sendDuration,
      tools: params.metadata?.tools ?? this.extractToolNames(response?.toolCalls) ?? params.existingRecord?.tools,
      tokenUsage:
        params.metadata?.tokenUsage ??
        this.asNumber(this.asRecord(reply?.usage)?.totalTokens) ??
        params.existingRecord?.tokenUsage,
      isFallback:
        params.metadata?.isFallback ??
        invocation?.isFallback ??
        params.existingRecord?.isFallback,
      fallbackSuccess:
        params.metadata?.fallbackSuccess ??
        this.asBoolean(fallback?.success) ??
        params.existingRecord?.fallbackSuccess,
      agentInvocation: params.metadata?.agentInvocation ?? params.existingRecord?.agentInvocation,
      batchId:
        params.metadata?.batchId ??
        this.asString(request?.batchId) ??
        params.existingRecord?.batchId,
    };
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
  private async saveRecordToDatabase(record: MessageProcessingRecordInput): Promise<void> {
    await this.withRetry(() => this.messageProcessingService.saveRecord(record));
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

  private async releaseActiveRequest(messageId: string): Promise<void> {
    try {
      await this.cacheService.incrementActiveRequests(-1);
    } catch (err) {
      this.logger.warn(`更新 activeRequests 失败 [${messageId}]:`, err);
    }
  }

  private asInvocation(value: unknown): InvocationSnapshot | undefined {
    if (!value || typeof value !== 'object') return undefined;
    return value as InvocationSnapshot;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private firstNumber(...values: Array<number | undefined>): number | undefined {
    return values.find((value) => value !== undefined);
  }

  private extractToolNames(toolCalls: unknown): string[] | undefined {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
    const toolNames = toolCalls
      .map((toolCall) => this.asString(this.asRecord(toolCall)?.toolName))
      .filter((toolName): toolName is string => Boolean(toolName));
    return toolNames.length > 0 ? toolNames : undefined;
  }

  private extractTimingSummary(value: unknown): InvocationTimingSummary {
    const summary = this.asRecord(value);
    const timestamps = this.asRecord(summary?.timestamps);
    const durations = this.asRecord(summary?.durations);

    return {
      timestamps: {
        acceptedAt: this.asNumber(timestamps?.acceptedAt),
        aiStartAt: this.asNumber(timestamps?.aiStartAt),
        aiEndAt: this.asNumber(timestamps?.aiEndAt),
      },
      durations: {
        acceptedToWorkerStartMs: this.asNumber(durations?.acceptedToWorkerStartMs),
        workerStartToAiStartMs: this.asNumber(durations?.workerStartToAiStartMs),
        aiStartToAiEndMs: this.asNumber(durations?.aiStartToAiEndMs),
        deliveryDurationMs: this.asNumber(durations?.deliveryDurationMs),
        totalMs: this.asNumber(durations?.totalMs),
      },
    };
  }
}
