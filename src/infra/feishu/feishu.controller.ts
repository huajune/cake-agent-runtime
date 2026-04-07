import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { AlertContext, FeishuAlertService } from './services/alert.service';

/**
 * 飞书基础设施控制器
 * 仅提供基础飞书能力的调试入口
 */
@Public()
@Controller('feishu')
export class FeishuController {
  private readonly logger = new Logger(FeishuController.name);

  constructor(private readonly alertService: FeishuAlertService) {}

  /**
   * 发送测试告警
   * POST /feishu/test/alert
   */
  @Post('test/alert')
  @HttpCode(200)
  async sendTestAlert(
    @Body() context: AlertContext,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(`发送测试告警: ${context.errorType}`);

    const sent = await this.alertService.sendAlert(context);

    return {
      success: sent,
      message: sent ? '告警已发送到飞书' : '告警发送失败或被节流',
    };
  }
}
