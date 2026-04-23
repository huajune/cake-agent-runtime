import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  toStorageMessageType,
  toStorageMessageSource,
  toStorageContactType,
} from '@enums/storage-message.enum';
import { ChatMessageRecord } from '../entities/chat-message.entity';
import { ChatMessageInput, ChatSessionSummary } from '../types/message.types';

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
   *
   * 返回 `inserted: true` 仅当 DB 真正插入了新行（message_id UNIQUE 冲突会返回
   * `false`），上层可据此决定是否把消息镜像到短期记忆缓存，避免重复写入。
   */
  async saveChatMessage(message: ChatMessageInput): Promise<{ inserted: boolean }> {
    if (!this.isAvailable()) {
      this.logger.warn('Supabase 未初始化，跳过聊天消息保存');
      return { inserted: false };
    }

    // 过滤群聊消息
    if (message.isRoom === true) {
      this.logger.debug(`跳过群聊消息存储: ${message.messageId}`);
      return { inserted: false };
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
      return { inserted: false };
    }

    try {
      const record = this.toDbRecord(message);

      const row = await this.upsert<ChatMessageRecord>(record, {
        onConflict: 'message_id',
        ignoreDuplicates: true,
        returnData: true,
      });

      return { inserted: row !== null };
    } catch (error) {
      this.logger.error('保存聊天消息失败', error);
      return { inserted: false };
    }
  }

  /**
   * 批量保存聊天消息
   *
   * 返回实际新插入的 message_id 集合（message_id UNIQUE 冲突的消息不在其中）。
   * 上层可据此镜像短期记忆缓存，保证 list 中不会出现重复条目。
   */
  async saveChatMessagesBatch(messages: ChatMessageInput[]): Promise<{ insertedIds: Set<string> }> {
    const empty = { insertedIds: new Set<string>() };
    if (!this.isAvailable() || messages.length === 0) {
      return empty;
    }

    // 过滤群聊消息
    const privateMessages = messages.filter((m) => m.isRoom !== true);

    if (privateMessages.length === 0) {
      this.logger.debug('批量写入：所有消息均为群聊，跳过');
      return empty;
    }

    try {
      const records = privateMessages.map((m) => this.toDbRecord(m));

      // 绕开 BaseRepository.upsertBatch：它不 select，拿不到被插入的行。
      // 这里直接走原生 upsert + select('message_id')，PostgREST 在
      // ignoreDuplicates=true 时只返回真正新插入的行，冲突行不在结果中。
      const { data, error } = await this.getClient()
        .from(this.tableName)
        .upsert(records as unknown as Record<string, unknown>[], {
          onConflict: 'message_id',
          ignoreDuplicates: true,
        })
        .select('message_id');

      if (error) {
        this.handleError('UPSERT_BATCH', error);
        return empty;
      }

      const insertedIds = new Set<string>(
        (data as Array<{ message_id: string }> | null)?.map((row) => row.message_id) ?? [],
      );
      this.logger.debug(`批量保存 ${insertedIds.size}/${privateMessages.length} 条新聊天消息`);
      return { insertedIds };
    } catch (error) {
      this.logger.error('批量保存聊天消息失败', error);
      return empty;
    }
  }

  // ==================== 消息查询 ====================

  /**
   * 获取会话的历史消息（用于 AI 上下文）
   * 双重限制：指定时间窗口 + 最多 limit 条
   */
  async getChatHistory(
    chatId: string,
    limit: number = 60,
    options?: { startTimeInclusive?: number; endTimeInclusive?: number },
  ): Promise<
    Array<{ messageId: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const startTime = options?.startTimeInclusive
        ? new Date(options.startTimeInclusive)
        : undefined;
      const endTime = options?.endTimeInclusive ? new Date(options.endTimeInclusive) : undefined;

      const results = await this.select<{
        message_id: string;
        role: string;
        content: string;
        timestamp: string;
      }>('message_id,role,content,timestamp', (q) => {
        let query = q.eq('chat_id', chatId);
        if (startTime) query = query.gte('timestamp', startTime.toISOString());
        if (endTime) query = query.lte('timestamp', endTime.toISOString());
        return query.order('timestamp', { ascending: false }).limit(limit);
      });

      // 返回时反转顺序（从旧到新）
      return results.reverse().map((m) => ({
        messageId: m.message_id,
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
   * 获取会话在指定时间边界内的消息。
   */
  async getChatHistoryInRange(
    chatId: string,
    options: { startTimeExclusive?: number; endTimeInclusive?: number },
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const results = await this.select<{ role: string; content: string; timestamp: string }>(
        'role,content,timestamp',
        (q) => {
          let query = q.eq('chat_id', chatId).order('timestamp');
          if (options.startTimeExclusive != null) {
            query = query.gt('timestamp', new Date(options.startTimeExclusive).toISOString());
          }
          if (options.endTimeInclusive != null) {
            query = query.lte('timestamp', new Date(options.endTimeInclusive).toISOString());
          }
          return query;
        },
      );

      return results.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
      }));
    } catch (error) {
      this.logger.error(`按时间范围获取会话历史失败 [${chatId}]:`, error);
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
      payload?: Record<string, unknown>;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const results = await this.select<ChatMessageRecord>(
        'message_id,role,content,timestamp,candidate_name,manager_name,message_type,source,contact_type,is_self,avatar,external_user_id,payload',
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
        payload: m.payload,
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
   * 委托给 getChatSessionListOptimized（使用 RPC，DB 侧 DISTINCT ON 聚合）。
   */
  async getChatSessionList(days: number = 1): Promise<ChatSessionSummary[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    return this.getChatSessionListByDateRange(startDate, endDate);
  }

  /**
   * 获取指定时间范围内的会话列表
   * 使用 RPC get_chat_session_list，在数据库侧通过 DISTINCT ON 完成聚合，
   * 避免拉取千行数据到内存再做 JS 分组。
   */
  async getChatSessionListByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<ChatSessionSummary[]> {
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

      if (!result) return [];

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
      this.logger.error('获取会话列表(时间范围)失败:', error);
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

  // ==================== 消息更新 ====================

  /**
   * 更新消息的 content 字段（按 message_id）
   *
   * 返回被更新行的 chat_id，供上层失效短期记忆缓存；messageId 不存在或失败返回 null。
   */
  async updateContentByMessageId(
    messageId: string,
    content: string,
  ): Promise<{ chatId: string | null }> {
    if (!this.isAvailable()) {
      return { chatId: null };
    }

    try {
      const rows = await this.update<ChatMessageRecord>({ content }, (q) =>
        q.eq('message_id', messageId),
      );
      return { chatId: rows[0]?.chat_id ?? null };
    } catch (error) {
      this.logger.error(`更新消息 content 失败 [${messageId}]:`, error);
      return { chatId: null };
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
