import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { FeishuCardColor } from './interfaces/interface';
import { FeishuCardBuilderService } from './services/card-builder.service';
import { FeishuWebhookChannel } from './constants/constants';
import { FeishuWebhookService } from './services/webhook.service';

interface FeishuTestMessageBody {
  channel?: FeishuWebhookChannel;
  title: string;
  content: string;
  color?: FeishuCardColor;
  atAll?: boolean;
}

/**
 * 飞书基础设施控制器
 * 仅提供基础飞书能力的调试入口
 */
@Public()
@Controller('feishu')
export class FeishuController {
  private readonly logger = new Logger(FeishuController.name);

  constructor(
    private readonly webhookService: FeishuWebhookService,
    private readonly cardBuilder: FeishuCardBuilderService,
  ) {}

  /**
   * 发送测试告警
   * POST /feishu/test/alert
   */
  @Post('test/alert')
  @HttpCode(200)
  async sendTestAlert(
    @Body() body: FeishuTestMessageBody,
  ): Promise<{ success: boolean; message: string }> {
    const channel = body.channel || 'ALERT';
    this.logger.log(`发送测试飞书消息: ${channel}`);

    const card = this.cardBuilder.buildMarkdownCard({
      title: body.title,
      content: body.content,
      color: body.color || 'blue',
      atAll: body.atAll,
    });
    const sent = await this.webhookService.sendMessage(channel, card);

    return {
      success: sent,
      message: sent ? '测试消息已发送到飞书' : '测试消息发送失败',
    };
  }
}
