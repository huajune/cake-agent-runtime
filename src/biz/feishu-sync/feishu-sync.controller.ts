import { Controller, Post, Body, HttpCode, BadRequestException } from '@nestjs/common';
import { ChatRecordSyncService } from './chat-record.service';
import { FeishuBitableSyncService } from './bitable-sync.service';
import {
  BadcaseGovernanceDocumentItem,
  BadcaseGovernanceDocumentService,
} from './badcase-governance-document.service';

/**
 * 飞书同步控制器
 * 提供聊天记录同步到飞书多维表格的接口
 */
@Controller('feishu/sync')
export class FeishuSyncController {
  constructor(
    private readonly chatRecordSyncService: ChatRecordSyncService,
    private readonly bitableSyncService: FeishuBitableSyncService,
    private readonly badcaseGovernanceDocumentService: BadcaseGovernanceDocumentService,
  ) {}

  @Post('badcase-governance/schema')
  @HttpCode(200)
  async ensureBadcaseGovernanceSchema(@Body() body: { apply?: boolean }) {
    return this.bitableSyncService.ensureBadcaseGovernanceFields(body.apply === true);
  }

  @Post('badcase-governance/document-check')
  @HttpCode(200)
  async checkBadcaseGovernanceDocument() {
    return this.badcaseGovernanceDocumentService.checkAccess();
  }

  /**
   * 往治理进展文档追加一条治理事件，并把「一、整体进展」「五、当前剩余问题」的数字刷新到实时值。
   *
   * 每日巡检这类直接改飞书表、不经 test-suite write-back 的链路走这里，
   * 让文档只有一个写入口：事件 ID 统一、幂等统一、统计数字不会停在历史值。
   * eventId 建议传稳定值（如 `bcg-daily-triage-20260730`），同一批变更不要既走这里又手写。
   */
  @Post('badcase-governance/document-append')
  @HttpCode(200)
  async appendBadcaseGovernanceDocument(
    @Body()
    body: {
      items: BadcaseGovernanceDocumentItem[];
      eventId?: string;
      occurredAt?: string;
      refreshSummary?: boolean;
    },
  ) {
    const items = body.items || [];
    if (items.length === 0) {
      throw new BadRequestException('items 不能为空');
    }
    const summaryCounts =
      body.refreshSummary === false ? undefined : await this.bitableSyncService.countOpenBadcases();
    return this.badcaseGovernanceDocumentService.appendUpdate({
      items,
      eventId: body.eventId,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
      refreshSummary: body.refreshSummary,
      summaryCounts,
    });
  }

  /**
   * 只刷新统计数字，不追加事件。用于文档被人手改过之后把数字拉回真实值。
   */
  @Post('badcase-governance/document-refresh-summary')
  @HttpCode(200)
  async refreshBadcaseGovernanceSummary() {
    const summaryCounts = await this.bitableSyncService.countOpenBadcases();
    return this.badcaseGovernanceDocumentService.refreshSummary({
      items: [],
      summaryCounts,
    });
  }

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
