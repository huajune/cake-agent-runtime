import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { AgentExecutionEventRepository } from '../../repositories/agent-execution-event.repository';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { ReengagementTouchRepository } from '../../repositories/reengagement-touch.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

/**
 * 数据清理服务（分层存储策略）
 *
 * 清理顺序（每日凌晨 3 点）:
 * 1. NULL agent_invocation（>N 天）— 释放 TOAST 空间，保留记录本身；
 *    agent_steps/tool_calls 不提前 NULL（工具统计兜底 RPC + badcase 证据需要处理链窗口），
 *    随消息处理行删除统一回收
 * 2. DELETE chat_messages（>N 天）
 * 3. DELETE guardrail_review_records（>N 天）— message_processing_records 的 trace 附属证据
 * 4. DELETE agent_execution_events（>N 天）— message_processing_records 的 trace 附属事件
 * 5. DELETE message_processing_records（>N 天）— 历史数据已聚合到 monitoring_hourly_stats
 * 6. DELETE monitoring_error_logs（>N 天）
 * 7. DELETE user_activity（>N 天）
 * 8. reengagement_touch_records：NULL generated_text（>N 天）+ DELETE 整行（>M 天）
 *    — 审计底账保留期比原始流水长
 *
 * monitoring_hourly_stats — 永久保留（~8760 行/年，约 5MB）
 *
 * 保留天数通过环境变量配置（Layer 2，有默认值）：
 * - DATA_CLEANUP_AGENT_INVOCATION_DAYS (默认 7)
 * - DATA_CLEANUP_PROCESSING_DAYS       (默认 60)
 * - DATA_CLEANUP_GUARDRAIL_REVIEW_DAYS (默认跟随 DATA_CLEANUP_PROCESSING_DAYS)
 * - DATA_CLEANUP_AGENT_EXECUTION_EVENTS_DAYS (默认跟随 DATA_CLEANUP_PROCESSING_DAYS)
 * - DATA_CLEANUP_CHAT_DAYS             (默认 60)
 * - DATA_CLEANUP_USER_ACTIVITY_DAYS    (默认 365)
 * - DATA_CLEANUP_ERROR_LOGS_DAYS       (默认 30)
 * - DATA_CLEANUP_TOUCH_TEXT_DAYS       (默认 30)
 * - DATA_CLEANUP_TOUCH_RECORDS_DAYS    (默认 90)
 */
@Injectable()
export class DataCleanupService implements OnModuleInit {
  private readonly logger = new Logger(DataCleanupService.name);

  private readonly agentInvocationRetentionDays: number;
  private readonly processingRetentionDays: number;
  private readonly guardrailReviewRetentionDays: number;
  private readonly agentExecutionEventsRetentionDays: number;
  private readonly chatRetentionDays: number;
  private readonly userActivityRetentionDays: number;
  private readonly errorLogsRetentionDays: number;
  private readonly touchTextRetentionDays: number;
  private readonly touchRecordsRetentionDays: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly chatSessionService: ChatSessionService,
    private readonly guardrailReviewService: GuardrailReviewService,
    private readonly messageProcessingService: MessageProcessingService,
    private readonly userHostingService: UserHostingService,
    private readonly agentExecutionEventRepository: AgentExecutionEventRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly reengagementTouchRepository: ReengagementTouchRepository,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {
    this.agentInvocationRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_AGENT_INVOCATION_DAYS', '7'),
      10,
    );
    this.processingRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_PROCESSING_DAYS', '60'),
      10,
    );
    this.guardrailReviewRetentionDays = parseInt(
      this.configService.get(
        'DATA_CLEANUP_GUARDRAIL_REVIEW_DAYS',
        String(this.processingRetentionDays),
      ),
      10,
    );
    this.agentExecutionEventsRetentionDays = parseInt(
      this.configService.get(
        'DATA_CLEANUP_AGENT_EXECUTION_EVENTS_DAYS',
        String(this.processingRetentionDays),
      ),
      10,
    );
    this.chatRetentionDays = parseInt(this.configService.get('DATA_CLEANUP_CHAT_DAYS', '60'), 10);
    this.userActivityRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_USER_ACTIVITY_DAYS', '365'),
      10,
    );
    this.errorLogsRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_ERROR_LOGS_DAYS', '30'),
      10,
    );
    this.touchTextRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_TOUCH_TEXT_DAYS', '30'),
      10,
    );
    this.touchRecordsRetentionDays = parseInt(
      this.configService.get('DATA_CLEANUP_TOUCH_RECORDS_DAYS', '90'),
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.isReadOnlyPreview()) {
      this.logger.warn('READ_ONLY_PREVIEW=true，跳过启动数据清理');
      return;
    }

    if (!this.supabaseService.isAvailable()) {
      this.logger.warn('⚠️ 数据清理服务已禁用 (Supabase 不可用)');
      return;
    }

    this.logger.log(
      `✅ 数据清理服务已启动 (agent_invocation ${this.agentInvocationRetentionDays}天NULL, ` +
        `处理记录 ${this.processingRetentionDays}天DELETE, ` +
        `聊天消息 ${this.chatRetentionDays}天DELETE, ` +
        `小时聚合永久保留)`,
    );

    // 启动时清理上次运行遗留的卡住记录，但绝不阻塞 bootstrap：
    // 若 Supabase 此刻不可达（如平台故障），Supabase SDK 的 fetch 默认 120s 超时
    // 会把 onModuleInit 卡到 deploy 健康检查窗口结束，触发误回滚。
    void this.timeoutStuckProcessingRecords().catch((error) => {
      this.logger.warn(
        `启动时清理卡住记录失败（不影响后续 cron 清理）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  /**
   * 每天凌晨 3 点执行分层清理
   */
  @Cron('0 3 * * *')
  async cleanupExpiredData(): Promise<void> {
    if (this.isReadOnlyPreview()) return;

    if (!this.supabaseService.isAvailable()) {
      return;
    }

    // 1. NULL agent_invocation（>7 天）— 释放 TOAST 空间
    //    agent_steps/tool_calls 随消息处理行删除回收（处理链窗口消费方依赖）
    await this.nullAgentInvocations();

    // 2. 清理过期聊天消息（>60 天）
    await this.cleanupChatMessages();

    // 3. 清理过期守卫审查档案（处理链附属证据，先删附属再删主流水）
    await this.cleanupGuardrailReviewRecords();

    // 4. 清理过期 Agent 执行事件（处理链附属证据，先删附属再删主流水）
    await this.cleanupAgentExecutionEvents();

    // 5. 清理过期消息处理记录（默认 >60 天）
    await this.cleanupMessageProcessingRecords();

    // 6. 清理过期错误日志（>30 天）
    await this.cleanupErrorLogs();

    // 7. 清理过期用户活跃记录（默认 >365 天）
    await this.cleanupUserActivity();

    // 8. 二次触发触达底账：NULL generated_text（>30 天）+ DELETE 整行（>90 天）
    await this.cleanupReengagementTouches();
  }

  /**
   * 每小时兜底：将卡住的 processing 记录标记为 timeout（>30 分钟）。
   *
   * 原先仅在启动时与每日凌晨 3 点执行，发版重启时被杀死的 in-flight 记录
   * 会在看板上以「处理中」挂最长一天，运营误以为消息还会被处理。
   * 与 onModuleInit 中的调用不冲突：onModuleInit 处理启动时遗留，此处兜底日间新卡住记录。
   */
  @Cron('0 * * * *')
  async timeoutStuckRecordsHourly(): Promise<void> {
    if (this.isReadOnlyPreview()) return;

    if (!this.supabaseService.isAvailable()) {
      return;
    }
    await this.timeoutStuckProcessingRecords();
    await this.interruptStalePostProcessing();
  }

  /**
   * 将过期 agent_invocation 置为 NULL（释放 TOAST 空间）。
   * agent_steps/tool_calls 不在此提前清理：工具统计兜底 RPC（get_dashboard_tool_stats）
   * 与 badcase 分析需要完整处理链窗口，随行删除统一回收。
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
   * 清理过期守卫审查档案
   */
  private async cleanupGuardrailReviewRecords(): Promise<void> {
    try {
      const deletedCount = await this.guardrailReviewService.cleanupExpiredReviews(
        this.guardrailReviewRetentionDays,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期守卫审查档案 (${this.guardrailReviewRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理守卫审查档案失败: ${message}`);
      this.notifyCleanupFailure('cleanup-guardrail-review-records', '清理守卫审查档案失败', error);
    }
  }

  /**
   * 清理过期 Agent 执行事件
   */
  private async cleanupAgentExecutionEvents(): Promise<void> {
    try {
      const deletedCount = await this.agentExecutionEventRepository.cleanupExpiredEvents(
        this.agentExecutionEventsRetentionDays,
      );
      if (deletedCount > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${deletedCount} 条过期 Agent 执行事件 (${this.agentExecutionEventsRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理 Agent 执行事件失败: ${message}`);
      this.notifyCleanupFailure('cleanup-agent-execution-events', '清理 Agent 执行事件失败', error);
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
   * 清理二次触发触达底账（reengagement_touch_records）
   * - >30 天：NULL generated_text（单列大文本，事后追溯价值随时间衰减）
   * - >90 天：DELETE 整行（审计底账保留期比 30 天原始流水更长）
   * 两步独立 try/catch：NULL 化失败不阻断行删除。
   */
  private async cleanupReengagementTouches(): Promise<{
    textsNulled: number;
    recordsDeleted: number;
  }> {
    let textsNulled = 0;
    let recordsDeleted = 0;

    try {
      textsNulled = await this.reengagementTouchRepository.nullExpiredGeneratedText(
        this.touchTextRetentionDays,
      );
      if (textsNulled > 0) {
        this.logger.log(
          `[数据清理] 已 NULL 化 ${textsNulled} 条触达记录的 generated_text (${this.touchTextRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] NULL 化触达记录 generated_text 失败: ${message}`);
      this.notifyCleanupFailure(
        'null-reengagement-touch-texts',
        'NULL 化触达记录 generated_text 失败',
        error,
      );
    }

    try {
      recordsDeleted = await this.reengagementTouchRepository.cleanupExpiredRecords(
        this.touchRecordsRetentionDays,
      );
      if (recordsDeleted > 0) {
        this.logger.log(
          `[数据清理] 已清理 ${recordsDeleted} 条过期触达记录 (${this.touchRecordsRetentionDays} 天前)`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 清理触达记录失败: ${message}`);
      this.notifyCleanupFailure('cleanup-reengagement-touch-records', '清理触达记录失败', error);
    }

    return { textsNulled, recordsDeleted };
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
   * 将卡死在 running 的 post_processing_status 标记为 interrupted。
   * turn-end 收尾中途进程被杀时终态不会落库，没有这步兜底，
   * 记录会永久显示"收尾进行中"，无法区分收尾丢失与正在执行。
   */
  private async interruptStalePostProcessing(): Promise<void> {
    try {
      const updatedCount = await this.messageProcessingService.interruptStalePostProcessing(30);
      if (updatedCount > 0) {
        this.logger.log(
          `[数据清理] 已将 ${updatedCount} 条收尾丢失的 post_processing_status 标记为 interrupted`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[数据清理] 标记 interrupted 失败: ${message}`);
      this.notifyCleanupFailure('interrupt-stale-post-processing', '标记收尾丢失记录失败', error);
    }
  }

  /**
   * 手动触发清理（用于测试或管理）
   */
  async triggerCleanup(): Promise<{
    agentInvocations: number;
    chatMessages: number;
    guardrailReviewRecords: number;
    agentExecutionEvents: number;
    processingRecords: number;
    userActivity: number;
    errorLogs: number;
    reengagementTouchTexts: number;
    reengagementTouchRecords: number;
  }> {
    let agentInvocations = 0;
    let chatMessages = 0;
    let guardrailReviewRecords = 0;
    let agentExecutionEvents = 0;
    let processingRecords = 0;
    let userActivity = 0;
    let errorLogs = 0;
    let reengagementTouchTexts = 0;
    let reengagementTouchRecords = 0;

    if (this.isReadOnlyPreview()) {
      this.logger.warn('[数据清理] READ_ONLY_PREVIEW=true，跳过手动清理');
      return {
        agentInvocations,
        chatMessages,
        guardrailReviewRecords,
        agentExecutionEvents,
        processingRecords,
        userActivity,
        errorLogs,
        reengagementTouchTexts,
        reengagementTouchRecords,
      };
    }

    if (!this.supabaseService.isAvailable()) {
      this.logger.warn('[数据清理] Supabase 不可用，跳过清理');
      return {
        agentInvocations,
        chatMessages,
        guardrailReviewRecords,
        agentExecutionEvents,
        processingRecords,
        userActivity,
        errorLogs,
        reengagementTouchTexts,
        reengagementTouchRecords,
      };
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
      guardrailReviewRecords = await this.guardrailReviewService.cleanupExpiredReviews(
        this.guardrailReviewRetentionDays,
      );
    } catch (error: unknown) {
      this.logger.warn(`[数据清理] 手动清理守卫审查档案失败: ${String(error)}`);
    }

    try {
      agentExecutionEvents = await this.agentExecutionEventRepository.cleanupExpiredEvents(
        this.agentExecutionEventsRetentionDays,
      );
    } catch (error: unknown) {
      this.logger.warn(`[数据清理] 手动清理 Agent 执行事件失败: ${String(error)}`);
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

    // 内部已按步 try/catch，失败计 0 不抛出
    const touches = await this.cleanupReengagementTouches();
    reengagementTouchTexts = touches.textsNulled;
    reengagementTouchRecords = touches.recordsDeleted;

    this.logger.log(
      `[数据清理] 手动清理完成: agent_invocation ${agentInvocations} 条, 聊天消息 ${chatMessages} 条, 守卫审查档案 ${guardrailReviewRecords} 条, Agent 执行事件 ${agentExecutionEvents} 条, 处理记录 ${processingRecords} 条, 用户活跃记录 ${userActivity} 条, 错误日志 ${errorLogs} 条, 触达文案 ${reengagementTouchTexts} 条, 触达记录 ${reengagementTouchRecords} 条`,
    );

    return {
      agentInvocations,
      chatMessages,
      guardrailReviewRecords,
      agentExecutionEvents,
      processingRecords,
      userActivity,
      errorLogs,
      reengagementTouchTexts,
      reengagementTouchRecords,
    };
  }

  private isReadOnlyPreview(): boolean {
    return this.configService.get<string>('READ_ONLY_PREVIEW', 'false') === 'true';
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
