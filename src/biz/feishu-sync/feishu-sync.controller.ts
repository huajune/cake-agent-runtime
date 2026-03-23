import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { ChatRecordSyncService } from './chat-record.service';

/**
 * 飞书同步控制器
 * 提供聊天记录同步到飞书多维表格的接口
 */
@Controller('feishu/sync')
export class FeishuSyncController {
  private readonly logger = new Logger(FeishuSyncController.name);

  constructor(private readonly chatRecordSyncService: ChatRecordSyncService) {}

  /**
   * 触发手动同步（前一天数据）
   * POST /feishu/sync/manual
   */
  @Post('manual')
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
  @Post('range')
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
