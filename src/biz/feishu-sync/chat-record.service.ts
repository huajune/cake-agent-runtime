import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import {
  FeishuBitableApiService,
  BatchCreateRequest,
} from '@infra/feishu/services/bitable-api.service';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

/**
 * 增强的消息历史记录项（用于飞书同步）
 */
interface EnhancedMessageHistoryItem {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  messageId: string;
  chatId: string;
  candidateName?: string;
  managerName?: string;
}

interface ExistingChatRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

interface SyncSummary {
  total: number;
  created: number;
  updated: number;
  failedCreate: number;
  failedUpdate: number;
}

/**
 * 聊天记录同步服务
 *
 * 职责：
 * - 每日 0 点将前一天的聊天记录从 Supabase 同步到飞书多维表格
 * - 支持手动触发同步和指定时间范围同步
 */
@Injectable()
export class ChatRecordSyncService {
  private readonly logger = new Logger(ChatRecordSyncService.name);

  constructor(
    private readonly chatSessionService: ChatSessionService,
    private readonly bitableApi: FeishuBitableApiService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {}

  /**
   * 每日 0 点同步前一日的聊天记录
   */
  @Cron('0 0 * * *', { timeZone: 'Asia/Shanghai' })
  async syncYesterdayChatRecords(): Promise<void> {
    if (this.isReadOnlyPreview()) return;

    this.logger.log('[ChatRecordSync] 开始同步前一日聊天记录到飞书多维表格...');

    const chatConfig = this.bitableApi.getTableConfig('chat');
    if (!chatConfig.appToken || !chatConfig.tableId) {
      this.logger.warn('[ChatRecordSync] 未配置完整的飞书表格参数，跳过同步');
      return;
    }

    try {
      const { start, end } = this.getYesterdayWindow();
      this.logger.log(
        `[ChatRecordSync] 时间范围: ${new Date(start).toISOString()} ~ ${new Date(end).toISOString()}`,
      );

      const summary = await this.syncWindow(chatConfig.appToken, chatConfig.tableId, start, end);

      this.logger.log(
        `[ChatRecordSync] ✓ 同步完成，会话: ${summary.total}，新增: ${summary.created}，更新: ${summary.updated}，失败: ${
          summary.failedCreate + summary.failedUpdate
        }`,
      );
    } catch (error: unknown) {
      const err = error as { message?: string; stack?: string };
      this.logger.error(`[ChatRecordSync] ✗ 同步失败: ${err?.message ?? error}`, err?.stack);
      this.exceptionNotifier?.notifyAsync({
        source: {
          subsystem: 'feishu-sync',
          component: 'ChatRecordService',
          action: 'syncYesterdayChatRecords',
          trigger: 'cron',
        },
        code: 'cron.job_failed',
        summary: '聊天记录飞书同步失败',
        error,
        severity: AlertLevel.ERROR,
      });
    }
  }

  /**
   * 手动触发同步（用于测试）
   */
  async manualSync(): Promise<{ success: boolean; message: string; recordCount?: number }> {
    try {
      await this.syncYesterdayChatRecords();
      return { success: true, message: '手动同步完成' };
    } catch (error: unknown) {
      const err = error as { message?: string };
      return { success: false, message: `同步失败: ${err?.message}` };
    }
  }

  /**
   * 同步指定时间范围的数据（仅用于测试）
   */
  async syncByTimeRange(
    startTime: number,
    endTime: number,
  ): Promise<{
    success: boolean;
    message: string;
    recordCount?: number;
    error?: string;
  }> {
    this.logger.log('[ChatRecordSync] 开始同步指定时间范围的聊天记录...');

    const chatConfig = this.bitableApi.getTableConfig('chat');
    if (!chatConfig.appToken || !chatConfig.tableId) {
      return { success: false, message: '未配置完整的飞书表格参数' };
    }

    try {
      this.logger.log(
        `[ChatRecordSync] 时间范围: ${new Date(startTime).toISOString()} ~ ${new Date(endTime).toISOString()}`,
      );

      const summary = await this.syncWindow(
        chatConfig.appToken,
        chatConfig.tableId,
        startTime,
        endTime,
      );

      if (summary.total === 0) {
        return { success: true, message: '指定时间范围内无聊天记录', recordCount: 0 };
      }

      if (summary.created === 0 && summary.updated === 0) {
        return { success: true, message: '无有效数据', recordCount: 0 };
      }

      return {
        success: true,
        message: `同步完成，新增: ${summary.created}，更新: ${summary.updated}，失败: ${
          summary.failedCreate + summary.failedUpdate
        }`,
        recordCount: summary.created + summary.updated,
      };
    } catch (error: unknown) {
      const err = error as { message?: string; stack?: string };
      this.logger.error(`[ChatRecordSync] ✗ 同步失败: ${err?.message ?? error}`, err?.stack);
      return { success: false, message: `同步失败: ${err?.message}`, error: err?.stack };
    }
  }

  // ==================== 私有方法 ====================

  private async syncWindow(
    appToken: string,
    tableId: string,
    startTime: number,
    endTime: number,
  ): Promise<SyncSummary> {
    const chatRecords = await this.getChatRecordsByTimeRange(startTime, endTime);
    if (chatRecords.length === 0) {
      this.logger.log('[ChatRecordSync] 指定时间范围内无聊天记录，跳过同步');
      return { total: 0, created: 0, updated: 0, failedCreate: 0, failedUpdate: 0 };
    }

    this.logger.log(`[ChatRecordSync] 找到 ${chatRecords.length} 个活跃会话，开始回查完整会话...`);

    const fullChatRecords = await this.hydrateFullChatRecords(chatRecords);
    const feishuRecords = this.convertToFeishuRecords(fullChatRecords);
    if (feishuRecords.length === 0) {
      this.logger.log('[ChatRecordSync] 无有效数据，跳过同步');
      return {
        total: chatRecords.length,
        created: 0,
        updated: 0,
        failedCreate: 0,
        failedUpdate: 0,
      };
    }

    const existingRecords = await this.getExistingChatRecordIndex(appToken, tableId);
    const createRecords: BatchCreateRequest[] = [];
    const updateRecords: Array<{ record_id: string; fields: Record<string, unknown> }> = [];

    for (const record of feishuRecords) {
      const chatId = this.normalizeFieldValue(record.fields.chatId);
      if (!chatId) continue;

      const existing = existingRecords.get(chatId);
      if (existing) {
        updateRecords.push({
          record_id: existing.recordId,
          fields: this.buildUpdateFields(record.fields),
        });
      } else {
        createRecords.push(record);
      }
    }

    const createResult =
      createRecords.length > 0
        ? await this.bitableApi.batchCreateRecords(appToken, tableId, createRecords, 100)
        : { created: 0, failed: 0 };

    const updateResult =
      updateRecords.length > 0
        ? await this.bitableApi.batchUpdateRecords(appToken, tableId, updateRecords)
        : { success: 0, failed: 0 };

    return {
      total: feishuRecords.length,
      created: createResult.created,
      updated: updateResult.success,
      failedCreate: createResult.failed,
      failedUpdate: updateResult.failed,
    };
  }

  /**
   * 查询飞书多维表格中已存在的 chatId，并保留 record_id 以支持日更。
   */
  private async getExistingChatRecordIndex(
    appToken: string,
    tableId: string,
  ): Promise<Map<string, ExistingChatRecord>> {
    const index = new Map<string, ExistingChatRecord>();
    const records = await this.bitableApi.getAllRecords(appToken, tableId);

    for (const record of records) {
      const chatId = this.normalizeFieldValue(record.fields?.chatId);
      if (chatId && !index.has(chatId)) {
        index.set(chatId, { recordId: record.record_id, fields: record.fields ?? {} });
      }
    }

    this.logger.log(`[ChatRecordSync] 查询到 ${index.size} 条已存在的 chatId`);
    return index;
  }

  /**
   * 时间窗口只负责找“活跃会话”。真正写入飞书时回查完整会话，避免更新已有行时
   * 把历史聊天覆盖成单日片段。
   */
  private async hydrateFullChatRecords(
    chatRecords: Array<{ chatId: string; messages: EnhancedMessageHistoryItem[] }>,
  ): Promise<Array<{ chatId: string; messages: EnhancedMessageHistoryItem[] }>> {
    const hydrated = await Promise.all(
      chatRecords.map(async (record) => {
        try {
          const detail = await this.chatSessionService.getChatSessionMessages(record.chatId);
          const messages = (detail.messages || []).map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            chatId: record.chatId,
            messageId: m.messageId,
            candidateName: m.candidateName,
            managerName: m.managerName,
          })) as EnhancedMessageHistoryItem[];

          return messages.length > 0 ? { chatId: record.chatId, messages } : record;
        } catch (error: unknown) {
          const err = error as { message?: string };
          this.logger.warn(
            `[ChatRecordSync] 回查完整会话失败 chatId=${record.chatId}: ${err?.message}，使用窗口内消息`,
          );
          return record;
        }
      }),
    );

    return hydrated;
  }

  private buildUpdateFields(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      chatId: fields.chatId,
      候选人微信昵称: fields.候选人微信昵称,
      招募经理姓名: fields.招募经理姓名,
      咨询时间: fields.咨询时间,
      聊天记录: fields.聊天记录,
      用户消息: fields.用户消息,
    };
  }

  /**
   * 转换聊天记录为飞书多维表格格式
   */
  private convertToFeishuRecords(
    chatRecords: Array<{ chatId: string; messages: EnhancedMessageHistoryItem[] }>,
  ): BatchCreateRequest[] {
    const records: BatchCreateRequest[] = [];

    for (const { chatId, messages } of chatRecords) {
      if (messages.length === 0) continue;

      // 提取候选人昵称
      const candidateName =
        messages
          .filter((m) => m.role === 'user' && m.candidateName && m.candidateName.trim())
          .map((m) => m.candidateName)[0] || '未知候选人';

      // 提取招募经理昵称
      const managerName =
        messages.find((m) => m.managerName && m.managerName.trim())?.managerName || '未知招募经理';

      // 咨询时间：第一条消息的时间
      const firstMessage = messages[0];
      const consultTimestamp = new Date(firstMessage.timestamp).getTime();

      // 聊天记录
      const chatLog = this.formatChatLog(messages);

      // 提取用户的第一条消息作为"用户消息"
      const userMessage = messages.find((m) => m.role === 'user')?.content || '';

      records.push({
        fields: {
          chatId,
          候选人微信昵称: candidateName,
          招募经理姓名: managerName,
          咨询时间: consultTimestamp,
          聊天记录: this.bitableApi.truncateText(chatLog, 5000),
          用户消息: this.bitableApi.truncateText(userMessage, 1000),
          标记为测试集: false,
        },
      });
    }

    return records;
  }

  /**
   * 格式化聊天记录为文本格式
   */
  private formatChatLog(messages: EnhancedMessageHistoryItem[]): string {
    return messages
      .map((msg) => {
        const time = new Date(msg.timestamp).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
        const speaker = msg.role === 'user' ? '候选人' : '招募经理';
        return `[${time} ${speaker}] ${msg.content}`;
      })
      .join('\n\n');
  }

  /**
   * 获取昨天的时间窗口
   */
  private getYesterdayWindow(): { start: number; end: number } {
    const end = this.getShanghaiTodayStart();
    const start = end - 24 * 60 * 60 * 1000;
    return { start, end };
  }

  private getShanghaiTodayStart(now = new Date()): number {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value;
    return Date.parse(`${part('year')}-${part('month')}-${part('day')}T00:00:00+08:00`);
  }

  private normalizeFieldValue(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            const obj = item as { text?: unknown; name?: unknown };
            return String(obj.text ?? obj.name ?? '');
          }
          return '';
        })
        .join('')
        .trim();
    }
    if (typeof value === 'object') {
      const obj = value as { text?: unknown; name?: unknown };
      return String(obj.text ?? obj.name ?? '').trim();
    }
    return String(value).trim();
  }

  /**
   * 获取指定时间范围内的所有聊天记录
   */
  private async getChatRecordsByTimeRange(
    startTime: number,
    endTime: number,
  ): Promise<Array<{ chatId: string; messages: EnhancedMessageHistoryItem[] }>> {
    this.logger.log(
      `查询时间范围内的聊天记录: ${new Date(startTime).toISOString()} ~ ${new Date(endTime).toISOString()}`,
    );

    const records = await this.chatSessionService.getChatMessagesByTimeRange(startTime, endTime);

    const result = records.map(({ chatId, messages }) => ({
      chatId,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        chatId,
        messageId: m.messageId,
        candidateName: m.candidateName,
        managerName: m.managerName,
      })) as EnhancedMessageHistoryItem[],
    }));

    this.logger.log(
      `时间范围查询完成：找到 ${result.length} 个会话共 ${result.reduce((sum, r) => sum + r.messages.length, 0)} 条消息`,
    );

    return result;
  }

  private isReadOnlyPreview(): boolean {
    return this.configService?.get<string>('READ_ONLY_PREVIEW', 'false') === 'true';
  }
}
