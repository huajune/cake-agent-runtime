import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '@core/supabase';
import { ChatMessageRepository, MessageProcessingRepository } from '@biz/message/repositories';
import { MonitoringErrorLogRepository } from '@biz/analytics/repositories';
import { UserHostingRepository } from '@biz/user/repositories';

/**
 * 数据清理服务（分层存储策略）
 *
 * 清理顺序（每日凌晨 3 点）:
 * 1. NULL agent_invocation（>7 天）— 释放 TOAST 空间，保留记录本身
 * 2. DELETE chat_messages（>60 天）
 * 3. DELETE message_processing_records（>14 天）— 历史数据已聚合到 monitoring_hourly_stats
 * 4. DELETE monitoring_error_logs（>30 天）
 * 5. DELETE user_activity（>35 天）
 *
 * monitoring_hourly_stats — 永久保留（~8760 行/年，约 5MB）
 */
@Injectable()
export class DataCleanupService implements OnModuleInit {
  private readonly logger = new Logger(DataCleanupService.name);

  private readonly AGENT_INVOCATION_RETENTION_DAYS = 7; // agent_invocation JSONB 保留 7 天后置 NULL
  private readonly PROCESSING_RETENTION_DAYS = 14; // 消息处理记录保留 14 天（历史数据已聚合到 hourly stats）
  private readonly CHAT_RETENTION_DAYS = 60; // 聊天记录保留 60 天
  private readonly USER_ACTIVITY_RETENTION_DAYS = 35; // 用户活跃记录保留 35 天（覆盖 Dashboard 月度视图）
  private readonly ERROR_LOGS_RETENTION_DAYS = 30; // 错误日志保留 30 天

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly chatMessageRepository: ChatMessageRepository,
    private readonly messageProcessingRepository: MessageProcessingRepository,
    private readonly userHostingRepository: UserHostingRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.supabaseService.isAvailable()) {
      this.logger.log(
        '✅ 数据清理服务已启动 (分层策略: agent_invocation 7天NULL, 处理记录 14天DELETE, 小时聚合永久保留)',
      );
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
      const updatedCount = await this.messageProcessingRepository.nullAgentInvocations(
        this.AGENT_INVOCATION_RETENTION_DAYS,
      );
      if (updatedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${updatedCount} 条 agent_invocation (${this.AGENT_INVOCATION_RETENTION_DAYS} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理 agent_invocation 失败: ${message}`);
    }
  }

  /**
   * 清理过期聊天消息
   */
  private async cleanupChatMessages(): Promise<void> {
    try {
      const deletedCount = await this.chatMessageRepository.cleanupChatMessages(
        this.CHAT_RETENTION_DAYS,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期聊天消息 (${this.CHAT_RETENTION_DAYS} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理聊天消息失败: ${message}`);
    }
  }

  /**
   * 清理过期消息处理记录
   */
  private async cleanupMessageProcessingRecords(): Promise<void> {
    try {
      const deletedCount = await this.messageProcessingRepository.cleanupMessageProcessingRecords(
        this.PROCESSING_RETENTION_DAYS,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期消息处理记录 (${this.PROCESSING_RETENTION_DAYS} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理消息处理记录失败: ${message}`);
    }
  }

  /**
   * 清理过期错误日志
   */
  private async cleanupErrorLogs(): Promise<void> {
    try {
      const deletedCount = await this.errorLogRepository.cleanupErrorLogs(
        this.ERROR_LOGS_RETENTION_DAYS,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期错误日志 (${this.ERROR_LOGS_RETENTION_DAYS} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理错误日志失败: ${message}`);
    }
  }

  /**
   * 清理过期用户活跃记录
   */
  private async cleanupUserActivity(): Promise<void> {
    try {
      const deletedCount = await this.userHostingRepository.cleanupUserActivity(
        this.USER_ACTIVITY_RETENTION_DAYS,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期用户活跃记录 (${this.USER_ACTIVITY_RETENTION_DAYS} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理用户活跃记录失败: ${message}`);
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
      agentInvocations = await this.messageProcessingRepository.nullAgentInvocations(
        this.AGENT_INVOCATION_RETENTION_DAYS,
      );
    } catch {
      // ignore
    }

    try {
      chatMessages = await this.chatMessageRepository.cleanupChatMessages(this.CHAT_RETENTION_DAYS);
    } catch {
      // ignore
    }

    try {
      processingRecords = await this.messageProcessingRepository.cleanupMessageProcessingRecords(
        this.PROCESSING_RETENTION_DAYS,
      );
    } catch {
      // ignore
    }

    try {
      userActivity = await this.userHostingRepository.cleanupUserActivity(
        this.USER_ACTIVITY_RETENTION_DAYS,
      );
    } catch {
      // ignore
    }

    try {
      errorLogs = await this.errorLogRepository.cleanupErrorLogs(this.ERROR_LOGS_RETENTION_DAYS);
    } catch {
      // ignore
    }

    this.logger.log(
      `[数据清理] 手动清理完成: agent_invocation ${agentInvocations} 条, 聊天消息 ${chatMessages} 条, 处理记录 ${processingRecords} 条, 用户活跃记录 ${userActivity} 条, 错误日志 ${errorLogs} 条`,
    );

    return { agentInvocations, chatMessages, processingRecords, userActivity, errorLogs };
  }
}
