import { Controller, Get, Post, HttpCode, Logger, Body, Inject, forwardRef } from '@nestjs/common';
import { MessageService } from '@wecom/message/message.service';
import { MessageProcessor } from '@wecom/message/message.processor';

/**
 * 监控运行时控制器
 * 管理运行时内存状态（AI 开关、聚合开关、Worker 并发）
 *
 * 这些端点涉及 "内存优先 → DB 持久化" 的双态模式，
 * 必须通过 MessageService / MessageProcessor 操作，不能直接走数据层。
 *
 * 路由前缀: /monitoring
 */
@Controller('monitoring')
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name);

  constructor(
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    @Inject(forwardRef(() => MessageProcessor))
    private readonly messageProcessor: MessageProcessor,
  ) {}

  // ==================== 功能开关 ====================

  /**
   * 获取 AI 回复开关状态
   * GET /monitoring/ai-reply-status
   */
  @Get('ai-reply-status')
  getAiReplyStatus(): { enabled: boolean } {
    this.logger.debug('获取 AI 回复开关状态');
    return { enabled: this.messageService.getAiReplyStatus() };
  }

  /**
   * 切换 AI 回复开关
   * POST /monitoring/toggle-ai-reply
   */
  @Post('toggle-ai-reply')
  @HttpCode(200)
  async toggleAiReply(
    @Body('enabled') enabled: boolean,
  ): Promise<{ enabled: boolean; message: string }> {
    this.logger.log(`切换 AI 回复开关: ${enabled}`);
    const newStatus = await this.messageService.toggleAiReply(enabled);
    return {
      enabled: newStatus,
      message: `AI 自动回复功能已${newStatus ? '启用' : '禁用'}（已持久化）`,
    };
  }

  /**
   * 获取消息聚合开关状态
   * GET /monitoring/message-merge-status
   */
  @Get('message-merge-status')
  getMessageMergeStatus(): { enabled: boolean } {
    this.logger.debug('获取消息聚合开关状态');
    return { enabled: this.messageService.getMessageMergeStatus() };
  }

  /**
   * 切换消息聚合开关
   * POST /monitoring/toggle-message-merge
   */
  @Post('toggle-message-merge')
  @HttpCode(200)
  async toggleMessageMerge(
    @Body('enabled') enabled: boolean,
  ): Promise<{ enabled: boolean; message: string }> {
    this.logger.log(`切换消息聚合开关: ${enabled}`);
    const newStatus = await this.messageService.toggleMessageMerge(enabled);
    return {
      enabled: newStatus,
      message: `消息聚合功能已${newStatus ? '启用' : '禁用'}（已持久化）`,
    };
  }

  // ==================== Worker 并发管理 ====================

  /**
   * 获取 Worker 状态
   * GET /monitoring/worker-status
   */
  @Get('worker-status')
  getWorkerStatus() {
    this.logger.debug('获取 Worker 状态');
    const baseStatus = this.messageProcessor.getWorkerStatus();
    return {
      ...baseStatus,
      messageMergeEnabled: this.messageService.getMessageMergeStatus(),
    };
  }

  /**
   * 设置 Worker 并发数
   * POST /monitoring/worker-concurrency
   */
  @Post('worker-concurrency')
  @HttpCode(200)
  async setWorkerConcurrency(@Body('concurrency') concurrency: number) {
    this.logger.log(`设置 Worker 并发数: ${concurrency}`);

    if (concurrency === undefined || concurrency === null) {
      return {
        success: false,
        message: 'concurrency 参数必填',
        previousConcurrency: this.messageProcessor.getWorkerStatus().concurrency,
        currentConcurrency: this.messageProcessor.getWorkerStatus().concurrency,
      };
    }

    return this.messageProcessor.setConcurrency(concurrency);
  }
}
