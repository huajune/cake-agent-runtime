import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MonitoringDatabaseService } from '@core/monitoring/monitoring-database.service';
import { MessageProcessingRecord } from '@core/monitoring/interfaces/monitoring.interface';
import { FeishuBitableApiService, BatchCreateRequest } from './feishu-bitable-api.service';

/**
 * Agent 测试反馈数据
 */
export interface AgentTestFeedback {
  type: 'badcase' | 'goodcase';
  chatHistory: string; // 格式化的聊天记录
  userMessage?: string; // 用户消息（最后一条用户输入）
  errorType?: string; // 错误类型（仅 badcase）
  remark?: string; // 备注
  chatId?: string; // 会话 ID
}

/**
 * 飞书多维表格同步服务
 *
 * 职责：
 * - 每日同步聊天记录到飞书
 * - 写入 Agent 测试反馈
 *
 * 重构说明：
 * - 使用 FeishuBitableApiService 进行 API 调用
 * - 移除重复的 Token 管理和配置加载代码
 */
@Injectable()
export class FeishuBitableSyncService {
  private readonly logger = new Logger(FeishuBitableSyncService.name);

  constructor(
    private readonly databaseService: MonitoringDatabaseService,
    private readonly bitableApi: FeishuBitableApiService,
  ) {}

  /**
   * 每日 0 点同步前一日数据
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async syncYesterday(): Promise<void> {
    const chatConfig = this.bitableApi.getTableConfig('chat');
    if (!chatConfig.appToken || !chatConfig.tableId) {
      this.logger.warn('[FeishuSync] 未配置完整的飞书表格参数，跳过同步');
      return;
    }

    // 从数据库读取昨天的记录
    const allRecords = await this.databaseService.getRecentDetailRecords(1000);
    if (!allRecords || allRecords.length === 0) {
      this.logger.warn('[FeishuSync] 未找到记录，跳过同步');
      return;
    }

    const window = this.getYesterdayWindow();
    const rows = (allRecords || [])
      .filter((r) => r.receivedAt >= window.start && r.receivedAt < window.end)
      .map((r) => this.buildFeishuRecord(r))
      .filter((item): item is BatchCreateRequest => !!item);

    if (rows.length === 0) {
      this.logger.log(
        `[FeishuSync] 前一日无可同步数据 (${new Date(window.start).toISOString()} ~ ${new Date(window.end).toISOString()})`,
      );
      return;
    }

    try {
      const result = await this.bitableApi.batchCreateRecords(
        chatConfig.appToken,
        chatConfig.tableId,
        rows,
      );
      this.logger.log(`[FeishuSync] 同步完成，成功: ${result.created}，失败: ${result.failed}`);
    } catch (error: any) {
      this.logger.error(`[FeishuSync] 同步失败: ${error?.message ?? error}`);
    }
  }

  /**
   * 写入 Agent 测试反馈到飞书多维表格
   */
  async writeAgentTestFeedback(
    feedback: AgentTestFeedback,
  ): Promise<{ success: boolean; recordId?: string; error?: string }> {
    const tableConfig = this.bitableApi.getTableConfig(feedback.type);
    if (!tableConfig?.appToken || !tableConfig?.tableId) {
      return { success: false, error: `${feedback.type} 表配置不完整` };
    }

    try {
      // 构建记录数据
      const fields: Record<string, unknown> = {
        候选人微信昵称: '测试用户',
        招募经理姓名: 'AI测试',
        咨询时间: Date.now(),
        聊天记录: this.bitableApi.truncateText(feedback.chatHistory, 10000),
      };

      // 用户消息（最后一条用户输入）
      if (feedback.userMessage) {
        fields['用户消息'] = this.bitableApi.truncateText(feedback.userMessage, 1000);
      }

      // 用例名称：自动生成随机 ID
      const randomId = Math.random().toString(36).substring(2, 10);
      fields['用例名称'] = randomId;

      if (feedback.chatId) {
        fields.chatId = feedback.chatId;
      }

      if (feedback.remark) {
        fields['备注'] = feedback.remark;
      }

      if (feedback.errorType) {
        fields['分类'] = feedback.errorType;
      }

      const result = await this.bitableApi.createRecord(
        tableConfig.appToken,
        tableConfig.tableId,
        fields,
      );

      this.logger.log(`[Feedback] 成功写入 ${feedback.type} 反馈, recordId: ${result.recordId}`);
      return { success: true, recordId: result.recordId };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Feedback] 写入异常: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  // ==================== 私有方法 ====================

  private buildFeishuRecord(record: MessageProcessingRecord): BatchCreateRequest | null {
    const userName = record.userName || record.userId;
    if (!userName) {
      return null;
    }

    const chatLogParts: string[] = [];
    if (record.messagePreview) chatLogParts.push(`[用户] ${record.messagePreview}`);
    if (record.replyPreview) chatLogParts.push(`[机器人] ${record.replyPreview}`);
    const chatLog = this.bitableApi.truncateText(chatLogParts.join('\n'), 2000);

    return {
      fields: {
        候选人微信昵称: userName,
        招募经理姓名: record.managerName || '未知招募经理',
        咨询时间: new Date(record.receivedAt).toISOString(),
        聊天记录: chatLog || '[空消息]',
        message_id: record.messageId,
        test_type: '对话验证',
      },
    };
  }

  private getYesterdayWindow(): { start: number; end: number } {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return { start: start.getTime(), end: end.getTime() };
  }
}
