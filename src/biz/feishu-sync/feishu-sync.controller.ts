import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { ChatRecordSyncService } from './chat-record.service';

/**
 * 飞书同步控制器
 * 提供聊天记录同步到飞书多维表格的接口
 */
@Controller('feishu/sync')
export class FeishuSyncController {
  constructor(private readonly chatRecordSyncService: ChatRecordSyncService) {}

  /**
   * 触发手动同步（前一天数据）
   * POST /feishu/sync/manual
   */
  @Post('manual')
  @HttpCode(200)
  async triggerManualSync(): Promise<{ success: boolean; message: string; count: number }> {
    const result = await this.chatRecordSyncService.manualSync();
    return {
      success: result.success,
      message: result.message,
      count: result.recordCount || 0,
    };
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
    return this.chatRecordSyncService.syncByDateRange(body.startDate, body.endDate);
  }
}
