import { Body, Controller, Logger, Post } from '@nestjs/common';
import { RawResponse, Public } from '@infra/server/response/decorators/api-response.decorator';
import { MessageService } from '../message.service';
import { MessageCallbackAdapterService } from './callback-adapter.service';
import { LogSanitizer } from '../utils/log-sanitizer.util';

@Public()
@Controller('message')
export class MessageIngressController {
  private readonly logger = new Logger(MessageIngressController.name);

  constructor(
    private readonly messageService: MessageService,
    private readonly callbackAdapter: MessageCallbackAdapterService,
  ) {}

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

  @RawResponse()
  @Post('sent-result')
  async receiveSentResult(@Body() body: unknown) {
    this.logger.debug('接收到发送结果回调 (sent-result)');
    return this.messageService.handleSentResult(body);
  }

  @RawResponse()
  @Post('sentResult')
  async receiveSentResultCamelCase(@Body() body: unknown) {
    this.logger.debug('接收到发送结果回调 (sentResult)');
    return this.messageService.handleSentResult(body);
  }
}
