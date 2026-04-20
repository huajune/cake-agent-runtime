import { Injectable, Logger } from '@nestjs/common';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';
import {
  MonitoringMetadata,
  MonitoringErrorLog,
  MonitoringGlobalCounters,
  AlertErrorType,
  AnomalyFlag,
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
   * 聚合时回收源消息的 processing 流水
   *
   * 聚合路径下，每条入站消息在 intake 时已写入一条 processing 行（recordMessageReceived），
   * 但终态只会回写到 batchId 那一行，源 messageId 行会永远停在 'processing'。
   * 该方法在聚合 trace 创建时同步回收：删除源行 + 扣减 activeRequests 计数。
   */
  async dropMergedSourceRecords(sourceMessageIds: string[], batchId: string): Promise<void> {
    if (sourceMessageIds.length === 0) return;
    try {
      await this.messageProcessingService.deleteByMessageIds(sourceMessageIds);
    } catch (err) {
      this.logger.warn(
        `[聚合回收] 删除源消息处理记录失败 batchId=${batchId}, sources=${sourceMessageIds.join(',')}:`,
        err,
      );
      return;
    }

    try {
      await this.cacheService.incrementActiveRequests(-sourceMessageIds.length);
    } catch (err) {
      this.logger.warn(`[聚合回收] activeRequests 扣减失败 batchId=${batchId}:`, err);
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
      const existingRecord = await this.messageProcessingService.getMessageProcessingRecordById(
        params.messageId,
      );
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
        this.cacheService
          .incrementCounter('totalSendDuration', record.sendDuration)
          .catch((err) => {
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
    const invocation = this.asInvocation(
      params.metadata?.agentInvocation ?? params.existingRecord?.agentInvocation,
    );
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
      alertType: params.metadata?.alertType ?? params.existingRecord?.alertType,
      scenario:
        params.metadata?.scenario ??
        this.asString(request?.scenario) ??
        params.existingRecord?.scenario,
      totalDuration: timings.durations.totalMs ?? params.existingRecord?.totalDuration,
      // 顶层 queueDuration 继续保留旧语义：accepted -> workerStart 的整体等待
      queueDuration:
        timings.durations.acceptedToWorkerStartMs ?? params.existingRecord?.queueDuration,
      prepDuration: timings.durations.workerStartToAiStartMs ?? params.existingRecord?.prepDuration,
      aiStartAt: timings.timestamps.aiStartAt ?? params.existingRecord?.aiStartAt,
      aiEndAt: timings.timestamps.aiEndAt ?? params.existingRecord?.aiEndAt,
      aiDuration: timings.durations.aiStartToAiEndMs ?? params.existingRecord?.aiDuration,
      sendDuration: timings.durations.deliveryDurationMs ?? params.existingRecord?.sendDuration,
      toolCalls:
        params.metadata?.toolCalls ??
        this.extractToolCalls(response?.toolCalls) ??
        params.existingRecord?.toolCalls,
      agentSteps:
        params.metadata?.agentSteps ??
        this.extractAgentSteps(response?.agentSteps) ??
        params.existingRecord?.agentSteps,
      memorySnapshot:
        params.metadata?.memorySnapshot ??
        this.extractMemorySnapshot(response?.memorySnapshot) ??
        params.existingRecord?.memorySnapshot,
      anomalyFlags: this.computeAnomalyFlags(
        params.metadata?.toolCalls ??
          this.extractToolCalls(response?.toolCalls) ??
          params.existingRecord?.toolCalls,
      ),
      tokenUsage:
        params.metadata?.tokenUsage ??
        this.asNumber(this.asRecord(reply?.usage)?.totalTokens) ??
        params.existingRecord?.tokenUsage,
      isFallback:
        params.metadata?.isFallback ?? invocation?.isFallback ?? params.existingRecord?.isFallback,
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

  /**
   * 从 invocation snapshot 中还原工具调用详情。
   *
   * 仅在 metadata.toolCalls 缺失（历史记录/老数据）时作为兜底使用。
   * 正常链路下 wecom-observability 会直接把结构化 toolCalls 填进 metadata。
   */
  private extractToolCalls(toolCalls: unknown): AgentToolCall[] | undefined {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
    const calls = toolCalls
      .map((toolCall) => {
        const record = this.asRecord(toolCall);
        if (!record) return null;
        const toolName = this.asString(record.toolName);
        if (!toolName) return null;
        const call: AgentToolCall = {
          toolName,
          args: (record.args ?? {}) as Record<string, unknown>,
          result: record.result,
          resultCount: this.asNumber(record.resultCount),
          status: record.status as AgentToolCall['status'],
          durationMs: this.asNumber(record.durationMs),
        };
        return call;
      })
      .filter((call): call is AgentToolCall => call !== null);
    return calls.length > 0 ? calls : undefined;
  }

  /**
   * 还原 agent_steps JSON：仅保留满足最小结构（数字 stepIndex + 数组 toolCalls）的条目。
   *
   * 历史/老数据可能没有 agent_steps，或字段缺失；不校验直接 cast 会让坏数据流到 UI。
   * 这里只做轻量字段断言，不做深度 schema 校验——下游消费方仍按 AgentStepDetail 处理。
   */
  private extractAgentSteps(agentSteps: unknown): AgentStepDetail[] | undefined {
    if (!Array.isArray(agentSteps) || agentSteps.length === 0) return undefined;

    const valid = agentSteps.filter((step): step is AgentStepDetail => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
      const record = step as Record<string, unknown>;
      if (typeof record.stepIndex !== 'number') return false;
      if (record.toolCalls !== undefined && !Array.isArray(record.toolCalls)) return false;
      return true;
    });

    return valid.length > 0 ? valid : undefined;
  }

  private extractMemorySnapshot(value: unknown): AgentMemorySnapshot | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as AgentMemorySnapshot;
  }

  /**
   * 根据工具调用序列计算异常信号标签。
   *
   * - tool_loop: 同一工具被调用 ≥ 3 次
   * - tool_empty_result: 有调用返回 0 条
   * - tool_narrow_result: 有调用返回 1 条
   * - tool_chain_overlong: 本轮工具链总长 ≥ 5
   */
  private computeAnomalyFlags(toolCalls: AgentToolCall[] | undefined): AnomalyFlag[] | undefined {
    if (!toolCalls || toolCalls.length === 0) return undefined;

    const flags = new Set<AnomalyFlag>();

    const counts = new Map<string, number>();
    for (const tc of toolCalls) {
      counts.set(tc.toolName, (counts.get(tc.toolName) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count >= 3)) flags.add('tool_loop');

    if (toolCalls.some((tc) => tc.status === 'empty')) flags.add('tool_empty_result');
    if (toolCalls.some((tc) => tc.status === 'narrow')) flags.add('tool_narrow_result');
    if (toolCalls.length >= 5) flags.add('tool_chain_overlong');

    return flags.size > 0 ? [...flags] : undefined;
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
