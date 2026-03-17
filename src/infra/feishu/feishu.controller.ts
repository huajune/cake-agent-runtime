import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { FeishuAlertService } from './services/alert.service';
import { FeishuBookingService } from './services/booking.service';
import { ChatRecordSyncService } from './services/chat-record.service';
import { InterviewBookingInfo } from './interfaces/interface';
import { AlertContext } from './services/alert.service';

/**
 * 飞书统一控制器
 * 提供测试接口，用于验证告警、通知和同步功能
 */
@Controller('feishu')
export class FeishuController {
  private readonly logger = new Logger(FeishuController.name);

  constructor(
    private readonly alertService: FeishuAlertService,
    private readonly bookingService: FeishuBookingService,
    private readonly chatRecordSyncService: ChatRecordSyncService,
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

  /**
   * 触发手动同步（前一天数据）
   * POST /feishu/sync/manual
   */
  @Post('sync/manual')
  @HttpCode(200)
  async triggerManualSync(): Promise<{ success: boolean; message: string; count: number }> {
    this.logger.log('触发手动同步（前一天数据）');

    try {
      const result = await this.chatRecordSyncService.manualSync();

      return {
        success: result.success,
        message: result.message,
        count: result.recordCount || 0,
      };
    } catch (error: any) {
      this.logger.error(`手动同步失败: ${error?.message}`);
      return {
        success: false,
        message: `同步失败: ${error?.message}`,
        count: 0,
      };
    }
  }

  /**
   * 同步指定日期范围的数据
   * POST /feishu/sync/range
   * @param body { startDate: '2024-11-28', endDate: '2024-11-30' }
   */
  @Post('sync/range')
  @HttpCode(200)
  async syncByDateRange(
    @Body() body: { startDate: string; endDate: string },
  ): Promise<{ success: boolean; message: string; recordCount?: number; error?: string }> {
    const { startDate, endDate } = body;

    if (!startDate || !endDate) {
      return {
        success: false,
        message: '请提供 startDate 和 endDate 参数（格式：YYYY-MM-DD）',
      };
    }

    this.logger.log(`触发手动同步: ${startDate} ~ ${endDate}`);

    try {
      // 解析日期，设置时区为中国时区
      const start = new Date(`${startDate}T00:00:00+08:00`).getTime();
      const end = new Date(`${endDate}T23:59:59+08:00`).getTime();

      if (isNaN(start) || isNaN(end)) {
        return {
          success: false,
          message: '日期格式错误，请使用 YYYY-MM-DD 格式',
        };
      }

      const result = await this.chatRecordSyncService.syncByTimeRange(start, end);

      return result;
    } catch (error: any) {
      this.logger.error(`手动同步失败: ${error?.message}`);
      return {
        success: false,
        message: `同步失败: ${error?.message}`,
        error: error?.stack,
      };
    }
  }
}
