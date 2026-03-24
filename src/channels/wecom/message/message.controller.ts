import { Controller, Post, Get, Body, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { MessageService } from './message.service';
import { MessageProcessor } from './message.processor';
import { RawResponse, Public } from '@infra/server/response/decorators/api-response.decorator';
import { MessageCallbackAdapterService } from './services/callback-adapter.service';
import { LogSanitizer } from './utils/log-sanitizer.util';

/**
 * 企微消息回调控制器
 *
 * 职责：HTTP 边界，接收企微推送并交给 MessageService 处理。
 * 仅包含 3 个回调端点，不含任何业务逻辑。
 *
 * 运行时开关（AI 回复、消息聚合）→ biz/hosting-config
 * 测试/诊断端点 → 已移除（使用集成测试脚本替代）
 */
@Public()
@Controller('message')
export class MessageController {
  private readonly logger = new Logger(MessageController.name);

  constructor(
    private readonly messageService: MessageService,
    private readonly callbackAdapter: MessageCallbackAdapterService,
    private readonly messageProcessor: MessageProcessor,
  ) {}

  /**
   * 接收企微机器人推送的消息（统一入口）
   * 自动识别并适配企业级/小组级回调格式
   */
  @RawResponse()
  @Post()
  async receiveMessage(@Body() body: unknown) {
    const callbackType = this.callbackAdapter.detectCallbackType(body);
    const rawData = (body as Record<string, unknown>).data || body;
    const messageId =
      (rawData as Record<string, unknown>).messageId || (body as Record<string, unknown>).messageId;

    this.logger.log(`=== [消息回调] 类型=${callbackType}, messageId=${messageId}`);
    this.logger.debug(
      `原始数据(已脱敏): ${JSON.stringify(LogSanitizer.sanitizeMessageCallback(rawData as Record<string, unknown>))}`,
    );

    const normalizedCallback = this.callbackAdapter.normalizeCallback(body);

    this.logger.log(
      `[标准化] messageId=${normalizedCallback.messageId}, chatId=${normalizedCallback.chatId}, ` +
        `isSelf=${normalizedCallback.isSelf}, source=${normalizedCallback.source}`,
    );

    const result = await this.messageService.handleMessage(normalizedCallback);

    this.logger.log(`[处理完成] messageId=${normalizedCallback.messageId}`);

    return result;
  }

  /**
   * 接收消息发送结果回调（连字符命名）
   */
  @RawResponse()
  @Post('sent-result')
  async receiveSentResult(@Body() body: unknown) {
    this.logger.debug('接收到发送结果回调 (sent-result)');
    return this.messageService.handleSentResult(body);
  }

  /**
   * 接收消息发送结果回调（驼峰命名，兼容托管平台）
   */
  @RawResponse()
  @Post('sentResult')
  async receiveSentResultCamelCase(@Body() body: unknown) {
    this.logger.debug('接收到发送结果回调 (sentResult)');
    return this.messageService.handleSentResult(body);
  }

  // ==================== Worker 管理 API ====================

  /**
   * 获取 Worker 状态（并发数、活跃任务数等）
   */
  @Get('worker-status')
  getWorkerStatus() {
    return this.messageProcessor.getWorkerStatus();
  }

  /**
   * 设置 Worker 并发数
   */
  @Post('worker-concurrency')
  async setWorkerConcurrency(@Body() body: { concurrency: number }) {
    const { concurrency } = body;
    if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1) {
      throw new HttpException('concurrency 必须是正整数', HttpStatus.BAD_REQUEST);
    }
    return this.messageProcessor.setConcurrency(concurrency);
  }
}
