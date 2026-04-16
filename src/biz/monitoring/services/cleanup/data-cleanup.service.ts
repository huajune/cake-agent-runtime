import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

/**
 * 数据清理服务（分层存储策略）
 *
 * 清理顺序（每日凌晨 3 点）:
 * 1. NULL agent_invocation（>N 天）— 释放 TOAST 空间，保留记录本身
 * 2. DELETE chat_messages（>N 天）
 * 3. DELETE message_processing_records（>N 天）— 历史数据已聚合到 monitoring_hourly_stats
 * 4. DELETE monitoring_error_logs（>N 天）
 * 5. DELETE user_activity（>N 天）
 *
 * monitoring_hourly_stats — 永久保留（~8760 行/年，约 5MB）
 *
 * 保留天数通过环境变量配置（Layer 2，有默认值）：
 * - DATA_CLEANUP_AGENT_INVOCATION_DAYS (默认 7)
 * - DATA_CLEANUP_PROCESSING_DAYS       (默认 14)
 * - DATA_CLEANUP_CHAT_DAYS             (默认 60)
 * - DATA_CLEANUP_USER_ACTIVITY_DAYS    (默认 35)
 * - DATA_CLEANUP_ERROR_LOGS_DAYS       (默认 30)
 */
@Injectable()
export class DataCleanupService implements OnModuleInit {
  private readonly logger = new Logger(DataCleanupService.name);

  private readonly agentInvocationRetentionDays: number;
  private readonly processingRetentionDays: number;
  private readonly chatRetentionDays: number;
  private readonly userActivityRetentionDays: number;
  private readonly errorLogsRetentionDays: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly chatSessionService: ChatSessionService,
    private readonly messageProcessingService: MessageProcessingService,
    private readonly userHostingService: UserHostingService,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {
    this.agentInvocationRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_AGENT_INVOCATION_DAYS', '7'),
      10,
    );
    this.processingRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_PROCESSING_DAYS', '14'),
      10,
    );
    this.chatRetentionDays = parseInt(this.configService.get('DATA_CLEANUP_CHAT_DAYS', '60'), 10);
    this.userActivityRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_USER_ACTIVITY_DAYS', '35'),
      10,
    );
    this.errorLogsRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_ERROR_LOGS_DAYS', '30'),
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.supabaseService.isAvailable()) {
      this.logger.log(
        `✅ 数据清理服务已启动 (agent_invocation ${this.agentInvocationRetentionDays}天NULL, ` +
          `处理记录 ${this.processingRetentionDays}天DELETE, ` +
          `聊天消息 ${this.chatRetentionDays}天DELETE, ` +
          `小时聚合永久保留)`,
      );

      // 启动时立即清理上次运行遗留的卡住记录（不等 cron）
      await this.timeoutStuckProcessingRecords();
    } else {
      this.logger.warn('⚠️ 数据清理服务已禁用 (Supabase 不可用)');
    }
  }

  /**
   * 每天凌晨 3 点执行分层清理
   */
  @Cron('0 3 * * *')
  async cleanupExpiredData(): Promise<void> {
    if (!this.supabaseService.isAvailable()) {
      return;
    }

    // 0. 将卡住的 processing 记录标记为 timeout（>30 分钟）
    // 与 onModuleInit 中的调用不冲突：onModuleInit 处理启动时遗留，此处处理日间新卡住记录
    await this.timeoutStuckProcessingRecords();

    // 1. NULL agent_invocation（>7 天）— 释放 TOAST 空间
    await this.nullAgentInvocations();

    // 2. 清理过期聊天消息（>60 天）
    await this.cleanupChatMessages();

    // 3. 清理过期消息处理记录（>14 天）
    await this.cleanupMessageProcessingRecords();

    // 4. 清理过期错误日志（>30 天）
    await this.cleanupErrorLogs();

    // 5. 清理过期用户活跃记录（>35 天）
    await this.cleanupUserActivity();
  }

  /**
   * 将过期 agent_invocation 置为 NULL（释放 TOAST 空间）
   */
  private async nullAgentInvocations(): Promise<void> {
    try {
      const updatedCount = await this.messageProcessingService.nullAgentInvocations(
        this.agentInvocationRetentionDays,
      );
      if (updatedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${updatedCount} 条 agent_invocation (${this.agentInvocationRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理 agent_invocation 失败: ${message}`);
      this.notifyCleanupFailure('null-agent-invocations', '清理 agent_invocation 失败', error);
    }
  }

  /**
   * 清理过期聊天消息
   */
  private async cleanupChatMessages(): Promise<void> {
    try {
      const deletedCount = await this.chatSessionService.cleanupChatMessages(
        this.chatRetentionDays,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期聊天消息 (${this.chatRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理聊天消息失败: ${message}`);
      this.notifyCleanupFailure('cleanup-chat-messages', '清理聊天消息失败', error);
    }
  }

  /**
   * 清理过期消息处理记录
   */
  private async cleanupMessageProcessingRecords(): Promise<void> {
    try {
      const deletedCount = await this.messageProcessingService.cleanupRecords(
        this.processingRetentionDays,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期消息处理记录 (${this.processingRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理消息处理记录失败: ${message}`);
      this.notifyCleanupFailure(
        'cleanup-message-processing-records',
        '清理消息处理记录失败',
        error,
      );
    }
  }

  /**
   * 清理过期错误日志
   */
  private async cleanupErrorLogs(): Promise<void> {
    try {
      const deletedCount = await this.errorLogRepository.cleanupErrorLogs(
        this.errorLogsRetentionDays,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期错误日志 (${this.errorLogsRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理错误日志失败: ${message}`);
      this.notifyCleanupFailure('cleanup-error-logs', '清理错误日志失败', error);
    }
  }

  /**
   * 清理过期用户活跃记录
   */
  private async cleanupUserActivity(): Promise<void> {
    try {
      const deletedCount = await this.userHostingService.cleanupActivity(
        this.userActivityRetentionDays,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期用户活跃记录 (${this.userActivityRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理用户活跃记录失败: ${message}`);
      this.notifyCleanupFailure('cleanup-user-activity', '清理用户活跃记录失败', error);
    }
  }

  /**
   * 将卡住的 processing 记录标记为 timeout
   * 用于兜底修正长期未终态化的请求记录
   */
  private async timeoutStuckProcessingRecords(): Promise<void> {
    try {
      const updatedCount = await this.messageProcessingService.timeoutStuckRecords(30);
      if (updatedCount > 0) {
        this.logger.log(`[数据清理] 已将 ${updatedCount} 条卡住的 processing 记录标记为 timeout`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 标记超时记录失败: ${message}`);
      this.notifyCleanupFailure('timeout-stuck-processing-records', '标记超时记录失败', error);
    }
  }

  /**
   * 手动触发清理（用于测试或管理）
   */
  async triggerCleanup(): Promise<{
    agentInvocations: number;
    chatMessages: number;
    processingRecords: number;
    userActivity: number;
    errorLogs: number;
  }> {
    let agentInvocations = 0;
    let chatMessages = 0;
    let processingRecords = 0;
    let userActivity = 0;
    let errorLogs = 0;

    if (!this.supabaseService.isAvailable()) {
      this.logger.warn('[数据清理] Supabase 不可用，跳过清理');
      return { agentInvocations, chatMessages, processingRecords, userActivity, errorLogs };
    }

    try {
      agentInvocations = await this.messageProcessingService.nullAgentInvocations(
        this.agentInvocationRetentionDays,
      );
    } catch (error: unknown) {
      this.logger.warn(`[数据清理] 手动清理 agent_invocation 失败: ${String(error)}`);
    }

    try {
      chatMessages = await this.chatSessionService.cleanupChatMessages(this.chatRetentionDays);
    } catch (error: unknown) {
      this.logger.warn(`[数据清理] 手动清理聊天消息失败: ${String(error)}`);
    }

    try {
      processingRecords = await this.messageProcessingService.cleanupRecords(
        this.processingRetentionDays,
      );
    } catch (error: unknown) {
      this.logger.warn(`[数据清理] 手动清理消息处理记录失败: ${String(error)}`);
    }

    try {
      userActivity = await this.userHostingService.cleanupActivity(this.userActivityRetentionDays);
    } catch (error: unknown) {
      this.logger.warn(`[数据清理] 手动清理用户活跃记录失败: ${String(error)}`);
    }

    try {
      errorLogs = await this.errorLogRepository.cleanupErrorLogs(this.errorLogsRetentionDays);
    } catch (error: unknown) {
      this.logger.warn(`[数据清理] 手动清理错误日志失败: ${String(error)}`);
    }

    this.logger.log(
      `[数据清理] 手动清理完成: agent_invocation ${agentInvocations} 条, 聊天消息 ${chatMessages} 条, 处理记录 ${processingRecords} 条, 用户活跃记录 ${userActivity} 条, 错误日志 ${errorLogs} 条`,
    );

    return { agentInvocations, chatMessages, processingRecords, userActivity, errorLogs };
  }

  private notifyCleanupFailure(source: string, title: string, error: unknown): void {
    this.exceptionNotifier?.notifyAsync({
      source: {
        subsystem: 'monitoring',
        component: 'DataCleanupService',
        action: source,
        trigger: 'cron',
      },
      code: 'cron.job_failed',
      summary: title,
      error,
      severity: AlertLevel.ERROR,
    });
  }
}
