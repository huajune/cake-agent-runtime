import { Injectable } from '@nestjs/common';
import { BaseRepository } from '../base.repository';
import { SupabaseService } from '../supabase.service';
import {
  StorageMessageType,
  StorageMessageSource,
  StorageContactType,
  toStorageMessageType,
  toStorageMessageSource,
  toStorageContactType,
} from '@wecom/message/enums';

/**
 * 聊天消息记录（Supabase 存储格式）
 */
export interface ChatMessageRecord {
  chat_id: string;
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  candidate_name?: string;
  manager_name?: string;
  org_id?: string;
  bot_id?: string;
  message_type?: StorageMessageType;
  source?: StorageMessageSource;
  is_room?: boolean;
  im_bot_id?: string;
  im_contact_id?: string;
  contact_type?: StorageContactType;
  is_self?: boolean;
  payload?: Record<string, unknown>;
  avatar?: string;
  external_user_id?: string;
}

/**
 * 聊天消息输入格式
 */
export interface ChatMessageInput {
  chatId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  candidateName?: string;
  managerName?: string;
  orgId?: string;
  botId?: string;
  messageType?: number;
  source?: number;
  isRoom?: boolean;
  imBotId?: string;
  imContactId?: string;
  contactType?: number;
  isSelf?: boolean;
  payload?: Record<string, unknown>;
  avatar?: string;
  externalUserId?: string;
}

/**
 * 会话列表查询的原始行
 */
interface SessionRawRow {
  chat_id: string;
  candidate_name?: string;
  manager_name?: string;
  content: string;
  timestamp: string;
  avatar?: string;
  contact_type?: string;
  role: string;
}

/**
 * 会话摘要（分组后的结果）
 */
export interface ChatSessionSummary {
  chatId: string;
  candidateName?: string;
  managerName?: string;
  messageCount: number;
  lastMessage?: string;
  lastTimestamp?: number;
  avatar?: string;
  contactType?: string;
}

/**
 * 聊天消息 Repository
 *
 * 负责管理 chat_messages 表的操作：
 * - 保存聊天消息
 * - 获取聊天历史
 * - 获取会话列表
 * - 数据清理
 */
@Injectable()
export class ChatMessageRepository extends BaseRepository {
  protected readonly tableName = 'chat_messages';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // ==================== 消息保存 ====================

  /**
   * 保存聊天消息到 Supabase
   * 注意：只存储个微私聊消息，群聊消息和非个微用户消息会被过滤
   */
  async saveChatMessage(message: ChatMessageInput): Promise<boolean> {
    if (!this.isAvailable()) {
      this.logger.warn('Supabase 未初始化，跳过聊天消息保存');
      return false;
    }

    // 过滤群聊消息
    if (message.isRoom === true) {
      this.logger.debug(`跳过群聊消息存储: ${message.messageId}`);
      return true;
    }

    // 只存储个微用户的消息（contactType === 1）
    if (
      message.role !== 'assistant' &&
      message.contactType !== undefined &&
      message.contactType !== 1
    ) {
      this.logger.debug(
        `跳过非个微用户消息存储: ${message.messageId}, contactType=${message.contactType}`,
      );
      return true;
    }

    try {
      const record = this.toDbRecord(message);

      await this.upsert(record, {
        onConflict: 'message_id',
        ignoreDuplicates: true,
        returnData: false,
      });

      return true;
    } catch (error) {
      this.logger.error('保存聊天消息失败', error);
      return false;
    }
  }

  /**
   * 批量保存聊天消息
   */
  async saveChatMessagesBatch(messages: ChatMessageInput[]): Promise<number> {
    if (!this.isAvailable() || messages.length === 0) {
      return 0;
    }

    // 过滤群聊消息
    const privateMessages = messages.filter((m) => m.isRoom !== true);

    if (privateMessages.length === 0) {
      this.logger.debug('批量写入：所有消息均为群聊，跳过');
      return 0;
    }

    try {
      const records = privateMessages.map((m) => this.toDbRecord(m));

      const count = await this.upsertBatch(records, {
        onConflict: 'message_id',
        ignoreDuplicates: true,
      });

      this.logger.debug(`批量保存 ${count} 条聊天消息成功`);
      return count;
    } catch (error) {
      this.logger.error('批量保存聊天消息失败', error);
      return 0;
    }
  }

  // ==================== 消息查询 ====================

  /**
   * 获取会话的历史消息（用于 AI 上下文）
   * 双重限制：近 3 天 + 最多 60 条
   */
  async getChatHistory(
    chatId: string,
    limit: number = 60,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

      const results = await this.select<{ role: string; content: string; timestamp: string }>(
        'role,content,timestamp',
        (q) =>
          q
            .eq('chat_id', chatId)
            .gte('timestamp', threeDaysAgo.toISOString())
            .order('timestamp', { ascending: false })
            .limit(limit),
      );

      // 返回时反转顺序（从旧到新）
      return results.reverse().map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
      }));
    } catch (error) {
      this.logger.error(`获取会话历史失败 [${chatId}]:`, error);
      return [];
    }
  }

  /**
   * 获取会话的完整历史消息（包含元数据）
   */
  async getChatHistoryDetail(chatId: string): Promise<
    Array<{
      messageId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      candidateName?: string;
      managerName?: string;
      messageType?: string;
      source?: string;
      contactType?: string;
      isSelf?: boolean;
      avatar?: string;
      externalUserId?: string;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const results = await this.select<ChatMessageRecord>(
        'message_id,role,content,timestamp,candidate_name,manager_name,message_type,source,contact_type,is_self,avatar,external_user_id',
        (q) => q.eq('chat_id', chatId).order('timestamp'),
      );

      return results.map((m) => ({
        messageId: m.message_id,
        role: m.role,
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
        candidateName: m.candidate_name,
        managerName: m.manager_name,
        messageType: m.message_type,
        source: m.source,
        contactType: m.contact_type,
        isSelf: m.is_self,
        avatar: m.avatar,
        externalUserId: m.external_user_id,
      }));
    } catch (error) {
      this.logger.error(`获取会话详情失败 [${chatId}]:`, error);
      return [];
    }
  }

  /**
   * 获取当天的聊天记录（用于仪表盘）
   */
  async getTodayChatMessages(
    date?: Date,
    page: number = 1,
    pageSize: number = 50,
  ): Promise<{
    messages: Array<{
      id: string;
      chatId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      candidateName?: string;
      managerName?: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    if (!this.isAvailable()) {
      return { messages: [], total: 0, page, pageSize };
    }

    try {
      const targetDate = date || new Date();
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);

      // 获取总数
      const total = await this.count((q) =>
        q.gte('timestamp', startOfDay.toISOString()).lte('timestamp', endOfDay.toISOString()),
      );

      // 获取分页数据
      const offset = (page - 1) * pageSize;
      const results = await this.select<{
        id: string;
        chat_id: string;
        role: string;
        content: string;
        timestamp: string;
        candidate_name?: string;
        manager_name?: string;
      }>('id,chat_id,role,content,timestamp,candidate_name,manager_name', (q) =>
        q
          .gte('timestamp', startOfDay.toISOString())
          .lte('timestamp', endOfDay.toISOString())
          .order('timestamp', { ascending: false })
          .range(offset, offset + pageSize - 1),
      );

      const messages = results.map((m) => ({
        id: m.id,
        chatId: m.chat_id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
        candidateName: m.candidate_name,
        managerName: m.manager_name,
      }));

      return { messages, total, page, pageSize };
    } catch (error) {
      this.logger.error('获取当天聊天记录失败:', error);
      return { messages: [], total: 0, page, pageSize };
    }
  }

  /**
   * 获取所有会话ID列表
   */
  async getAllChatIds(): Promise<string[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      // 尝试使用 RPC 函数
      const result = await this.rpc<Array<{ chat_id: string }>>('get_distinct_chat_ids');

      if (result) {
        return result.map((row) => row.chat_id);
      }

      // 回退到直接查询
      return this.getAllChatIdsFallback();
    } catch (error) {
      this.logger.error('获取所有会话ID失败:', error);
      return [];
    }
  }

  private async getAllChatIdsFallback(): Promise<string[]> {
    try {
      const results = await this.select<{ chat_id: string }>('chat_id', (q) => q.order('chat_id'));

      const chatIds = new Set<string>();
      for (const m of results) {
        chatIds.add(m.chat_id);
      }

      return Array.from(chatIds);
    } catch (error) {
      this.logger.error('获取所有会话ID失败（回退）:', error);
      return [];
    }
  }

  /**
   * 获取会话列表（用于 Dashboard 展示）
   */
  async getChatSessionList(days: number = 1): Promise<ChatSessionSummary[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(0, 0, 0, 0);

      const results = await this.select<SessionRawRow>(
        'chat_id,candidate_name,manager_name,content,timestamp,avatar,contact_type,role',
        (q) =>
          q
            .gte('timestamp', startDate.toISOString())
            .order('timestamp', { ascending: false })
            .limit(10000),
      );

      return this.groupMessagesBySession(results);
    } catch (error) {
      this.logger.error('获取会话列表失败:', error);
      return [];
    }
  }

  /**
   * 获取指定时间范围内的会话列表
   * v1.4: 支持精确的时间范围筛选
   */
  async getChatSessionListByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<ChatSessionSummary[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const results = await this.select<SessionRawRow>(
        'chat_id,candidate_name,manager_name,content,timestamp,avatar,contact_type,role',
        (q) =>
          q
            .gte('timestamp', startDate.toISOString())
            .lte('timestamp', endDate.toISOString())
            .order('timestamp', { ascending: false })
            .limit(1000),
      );

      return this.groupMessagesBySession(results);
    } catch (error) {
      this.logger.error('获取会话列表(时间范围)失败:', error);
      return [];
    }
  }

  /**
   * 获取会话列表（优化版，使用数据库 RPC 函数）
   */
  async getChatSessionListOptimized(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      chatId: string;
      candidateName?: string;
      managerName?: string;
      messageCount: number;
      lastMessage?: string;
      lastTimestamp?: number;
      avatar?: string;
      contactType?: string;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          chat_id: string;
          candidate_name?: string;
          manager_name?: string;
          message_count: string;
          last_message?: string;
          last_timestamp?: string;
          avatar?: string;
          contact_type?: string;
        }>
      >('get_chat_session_list', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) {
        return [];
      }

      this.logger.log(
        `获取会话列表: ${result.length} 个会话（${startDate.toISOString().split('T')[0]} ~ ${endDate.toISOString().split('T')[0]}）`,
      );

      return result.map((item) => ({
        chatId: item.chat_id,
        candidateName: item.candidate_name,
        managerName: item.manager_name,
        messageCount: parseInt(item.message_count, 10),
        lastMessage: item.last_message,
        lastTimestamp: item.last_timestamp ? new Date(item.last_timestamp).getTime() : undefined,
        avatar: item.avatar,
        contactType: item.contact_type,
      }));
    } catch (error) {
      this.logger.error('获取会话列表(优化版)失败:', error);
      return [];
    }
  }

  // ==================== 统计相关 ====================

  /**
   * 获取每日聊天统计数据
   */
  async getChatDailyStats(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      date: string;
      messageCount: number;
      sessionCount: number;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          date: string;
          message_count: string;
          session_count: string;
        }>
      >('get_chat_daily_stats', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) {
        return [];
      }

      return result.map((item) => ({
        date: item.date,
        messageCount: parseInt(item.message_count, 10),
        sessionCount: parseInt(item.session_count, 10),
      }));
    } catch (error) {
      this.logger.error('获取每日聊天统计失败:', error);
      return [];
    }
  }

  /**
   * 获取聊天汇总统计数据
   */
  async getChatSummaryStats(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    totalSessions: number;
    totalMessages: number;
    activeSessions: number;
  }> {
    if (!this.isAvailable()) {
      return { totalSessions: 0, totalMessages: 0, activeSessions: 0 };
    }

    try {
      const result = await this.rpc<
        Array<{
          total_sessions: string;
          total_messages: string;
          active_sessions: string;
        }>
      >('get_chat_summary_stats', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result || result.length === 0) {
        return { totalSessions: 0, totalMessages: 0, activeSessions: 0 };
      }

      const stats = result[0];
      return {
        totalSessions: parseInt(stats.total_sessions, 10),
        totalMessages: parseInt(stats.total_messages, 10),
        activeSessions: parseInt(stats.active_sessions, 10),
      };
    } catch (error) {
      this.logger.error('获取聊天汇总统计失败:', error);
      return { totalSessions: 0, totalMessages: 0, activeSessions: 0 };
    }
  }

  // ==================== 时间范围查询 ====================

  /**
   * 获取指定时间范围内的聊天记录（按会话分组）
   * @param startTime 开始时间（毫秒时间戳）
   * @param endTime 结束时间（毫秒时间戳）
   */
  async getChatMessagesByTimeRange(
    startTime: number,
    endTime: number,
  ): Promise<
    Array<{
      chatId: string;
      messages: Array<{
        messageId: string;
        role: 'user' | 'assistant';
        content: string;
        timestamp: number;
        candidateName?: string;
        managerName?: string;
      }>;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const startIso = new Date(startTime).toISOString();
      const endIso = new Date(endTime).toISOString();

      const results = await this.select<{
        chat_id: string;
        message_id: string;
        role: string;
        content: string;
        timestamp: string;
        candidate_name?: string;
        manager_name?: string;
      }>('chat_id,message_id,role,content,timestamp,candidate_name,manager_name', (q) =>
        q.gte('timestamp', startIso).lt('timestamp', endIso).order('chat_id').order('timestamp'),
      );

      // 按 chat_id 分组
      const grouped = new Map<
        string,
        Array<{
          messageId: string;
          role: 'user' | 'assistant';
          content: string;
          timestamp: number;
          candidateName?: string;
          managerName?: string;
        }>
      >();

      for (const m of results) {
        const chatId = m.chat_id;
        if (!grouped.has(chatId)) {
          grouped.set(chatId, []);
        }
        grouped.get(chatId)!.push({
          messageId: m.message_id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          timestamp: new Date(m.timestamp).getTime(),
          candidateName: m.candidate_name,
          managerName: m.manager_name,
        });
      }

      return Array.from(grouped.entries()).map(([chatId, messages]) => ({
        chatId,
        messages,
      }));
    } catch (error) {
      this.logger.error('获取时间范围内的聊天记录失败:', error);
      return [];
    }
  }

  // ==================== 数据清理 ====================

  /**
   * 清理过期的聊天消息
   */
  async cleanupChatMessages(retentionDays: number = 90): Promise<number> {
    if (!this.isAvailable()) {
      this.logger.warn('Supabase 未初始化，跳过聊天消息清理');
      return 0;
    }

    try {
      const result = await this.rpc<number>('cleanup_chat_messages', {
        retention_days: retentionDays,
      });

      const deletedCount = result ?? 0;
      if (deletedCount > 0) {
        this.logger.log(`✅ 聊天消息清理完成: 删除 ${deletedCount} 条 ${retentionDays} 天前的消息`);
      }
      return deletedCount;
    } catch (error) {
      this.logger.error('清理聊天消息失败:', error);
      return 0;
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 将消息列表按 chat_id 分组为会话摘要（去重逻辑）
   */
  private groupMessagesBySession(rows: SessionRawRow[]): ChatSessionSummary[] {
    const sessionMap = new Map<string, ChatSessionSummary>();

    for (const msg of rows) {
      const chatId = msg.chat_id;
      if (!sessionMap.has(chatId)) {
        sessionMap.set(chatId, {
          chatId,
          candidateName: msg.role === 'user' ? msg.candidate_name : undefined,
          managerName: msg.manager_name,
          messageCount: 1,
          lastMessage: msg.content?.substring(0, 50) + (msg.content?.length > 50 ? '...' : ''),
          lastTimestamp: new Date(msg.timestamp).getTime(),
          avatar: msg.role === 'user' ? msg.avatar : undefined,
          contactType: msg.role === 'user' ? msg.contact_type : undefined,
        });
      } else {
        const session = sessionMap.get(chatId)!;
        session.messageCount++;
        if (!session.candidateName && msg.role === 'user' && msg.candidate_name) {
          session.candidateName = msg.candidate_name;
        }
        if (!session.managerName && msg.manager_name) {
          session.managerName = msg.manager_name;
        }
        if (!session.avatar && msg.role === 'user' && msg.avatar) {
          session.avatar = msg.avatar;
        }
        if (!session.contactType && msg.contact_type && msg.role === 'user') {
          session.contactType = msg.contact_type;
        }
      }
    }

    return Array.from(sessionMap.values()).sort(
      (a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0),
    );
  }

  /**
   * 转换为数据库记录格式
   */
  private toDbRecord(message: ChatMessageInput): ChatMessageRecord {
    return {
      chat_id: message.chatId,
      message_id: message.messageId,
      role: message.role,
      content: message.content,
      timestamp: new Date(message.timestamp).toISOString(),
      candidate_name: message.candidateName,
      manager_name: message.managerName,
      org_id: message.orgId,
      bot_id: message.botId,
      message_type: toStorageMessageType(message.messageType),
      source: toStorageMessageSource(message.source),
      is_room: message.isRoom ?? false,
      im_bot_id: message.imBotId,
      im_contact_id: message.imContactId,
      contact_type: toStorageContactType(message.contactType),
      is_self: message.isSelf,
      payload: message.payload,
      avatar: message.avatar,
      external_user_id: message.externalUserId,
    };
  }
}
