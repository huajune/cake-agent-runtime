import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChatMessageRepository } from '@biz/message/repositories/chat-message.repository';
import {
  FeishuBitableApiService,
  BatchCreateRequest,
} from '@infra/feishu/services/bitable-api.service';

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
    private readonly chatMessageRepository: ChatMessageRepository,
    private readonly bitableApi: FeishuBitableApiService,
  ) {}

  /**
   * 每日 0 点同步前一日的聊天记录
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async syncYesterdayChatRecords(): Promise<void> {
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

      const chatRecords = await this.getChatRecordsByTimeRange(start, end);
      if (chatRecords.length === 0) {
        this.logger.log('[ChatRecordSync] 前一日无聊天记录，跳过同步');
        return;
      }

      this.logger.log(`[ChatRecordSync] 找到 ${chatRecords.length} 个会话，开始转换数据...`);

      const feishuRecords = this.convertToFeishuRecords(chatRecords);
      if (feishuRecords.length === 0) {
        this.logger.log('[ChatRecordSync] 无有效数据，跳过同步');
        return;
      }

      // 查询已存在的 chatId（用于去重）
      const existingChatIds = await this.getExistingChatIds(
        chatConfig.appToken,
        chatConfig.tableId,
      );
      const newRecords = feishuRecords.filter((r) => {
        const chatId = r.fields.chatId as string;
        return !existingChatIds.has(chatId);
      });

      if (newRecords.length === 0) {
        this.logger.log('[ChatRecordSync] 所有记录均已存在，跳过写入');
        return;
      }

      this.logger.log(
        `[ChatRecordSync] 过滤后剩余 ${newRecords.length} 条新记录（已过滤 ${feishuRecords.length - newRecords.length} 条重复）`,
      );

      const result = await this.bitableApi.batchCreateRecords(
        chatConfig.appToken,
        chatConfig.tableId,
        newRecords,
        100,
      );

      this.logger.log(
        `[ChatRecordSync] ✓ 同步完成，成功: ${result.created}，失败: ${result.failed}`,
      );
    } catch (error: unknown) {
      const err = error as { message?: string; stack?: string };
      this.logger.error(`[ChatRecordSync] ✗ 同步失败: ${err?.message ?? error}`, err?.stack);
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

      const chatRecords = await this.getChatRecordsByTimeRange(startTime, endTime);
      if (chatRecords.length === 0) {
        return { success: true, message: '指定时间范围内无聊天记录', recordCount: 0 };
      }

      const feishuRecords = this.convertToFeishuRecords(chatRecords);
      if (feishuRecords.length === 0) {
        return { success: true, message: '无有效数据', recordCount: 0 };
      }

      // 查询已存在的 chatId（用于去重）
      const existingChatIds = await this.getExistingChatIds(
        chatConfig.appToken,
        chatConfig.tableId,
      );
      const newRecords = feishuRecords.filter((r) => {
        const chatId = r.fields.chatId as string;
        return !existingChatIds.has(chatId);
      });

      if (newRecords.length === 0) {
        return { success: true, message: '所有记录均已存在', recordCount: 0 };
      }

      const result = await this.bitableApi.batchCreateRecords(
        chatConfig.appToken,
        chatConfig.tableId,
        newRecords,
        100,
      );

      return {
        success: true,
        message: `同步完成，成功: ${result.created}，失败: ${result.failed}`,
        recordCount: result.created,
      };
    } catch (error: unknown) {
      const err = error as { message?: string; stack?: string };
      this.logger.error(`[ChatRecordSync] ✗ 同步失败: ${err?.message ?? error}`, err?.stack);
      return { success: false, message: `同步失败: ${err?.message}`, error: err?.stack };
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 查询飞书多维表格中已存在的 chatId（用于去重）
   */
  private async getExistingChatIds(appToken: string, tableId: string): Promise<Set<string>> {
    const existingChatIds = new Set<string>();

    try {
      const records = await this.bitableApi.getAllRecords(appToken, tableId);

      for (const record of records) {
        const chatId = record.fields?.chatId;
        if (chatId && typeof chatId === 'string') {
          existingChatIds.add(chatId);
        }
      }

      this.logger.log(`[ChatRecordSync] 查询到 ${existingChatIds.size} 条已存在的记录`);
    } catch (error: unknown) {
      const err = error as { message?: string };
      this.logger.warn(`[ChatRecordSync] 查询已存在记录失败: ${err?.message}，将跳过去重`);
    }

    return existingChatIds;
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
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);
    return { start: start.getTime(), end: end.getTime() };
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

    const records = await this.chatMessageRepository.getChatMessagesByTimeRange(startTime, endTime);

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
}
