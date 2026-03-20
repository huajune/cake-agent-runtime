import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { Public } from '@infra/server/response/decorators/api-response.decorator';
import { FeishuAlertService } from './services/alert.service';
import { FeishuBookingService } from './services/booking.service';
import { InterviewBookingInfo } from './interfaces/interface';
import { AlertContext } from './services/alert.service';

/**
 * 飞书基础设施控制器
 * 提供告警和预约通知的测试接口
 */
@Public()
@Controller('feishu')
export class FeishuController {
  private readonly logger = new Logger(FeishuController.name);

  constructor(
    private readonly alertService: FeishuAlertService,
    private readonly bookingService: FeishuBookingService,
  ) {}

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

  /**
   * 发送测试预约通知
   * POST /feishu/test/booking
   */
  @Post('test/booking')
  @HttpCode(200)
  async sendTestBooking(
    @Body() bookingInfo: InterviewBookingInfo,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(`发送测试预约通知: ${bookingInfo.candidateName}`);

    const sent = await this.bookingService.sendBookingNotification(bookingInfo);

    return {
      success: sent,
      message: sent ? '预约通知已发送到飞书' : '预约通知发送失败',
    };
  }
}
