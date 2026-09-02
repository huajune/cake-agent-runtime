import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  toStorageMessageType,
  toStorageMessageSource,
  toStorageContactType,
  type StorageMessageSource,
  type StorageMessageType,
} from '@enums/storage-message.enum';
import { ChatMessageRecord } from '../entities/chat-message.entity';
import { ChatMessageInput, ChatSessionPage, ChatSessionPageQuery } from '../types/message.types';
import { EMOTION_MESSAGE_PREFIX, IMAGE_MESSAGE_PREFIX } from '@resolution/signal/markers';

/**
 * 聊天消息 Repository
 *
 * 负责管理 chat_messages 表的操作：
 * - 保存聊天消息
 * - 获取聊天历史
 * - 获取会话列表
 * - 数据清理
 */
/** 会话列表默认页大小：一屏够用，且单页往返稳定在亚秒级。 */
const DEFAULT_SESSION_PAGE_SIZE = 200;
/** 单页上限，防止调用方传入超大 limit 把 PostgREST 载荷打爆。 */
const MAX_SESSION_PAGE_SIZE = 500;

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
    Array<{
      messageId: string;
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
      source?: StorageMessageSource;
      messageType?: StorageMessageType;
      isSelf?: boolean;
      payloadSource?: string;
    }>
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
        source?: StorageMessageSource;
        message_type?: StorageMessageType;
        is_self?: boolean;
        payload_source?: string;
      }>(
        'message_id,role,content,timestamp,source,message_type,is_self,payload_source:payload->>source',
        (q) => {
          let query = q.eq('chat_id', chatId);
          if (startTime) query = query.gte('timestamp', startTime.toISOString());
          if (endTime) query = query.lte('timestamp', endTime.toISOString());
          return query.order('timestamp', { ascending: false }).limit(limit);
        },
      );

      // 返回时反转顺序（从旧到新）
      return results.reverse().map((m) => ({
        messageId: m.message_id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: new Date(m.timestamp).getTime(),
        source: m.source,
        messageType: m.message_type,
        isSelf: m.is_self,
        payloadSource: m.payload_source,
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
    options: { startTimeExclusive?: number; endTimeInclusive?: number; limit?: number },
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
          if (options.limit != null) {
            query = query.limit(options.limit);
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
   */
  async getChatSessionList(
    days: number = 1,
    limit = DEFAULT_SESSION_PAGE_SIZE,
  ): Promise<ChatSessionPage> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    return this.getChatSessionPage({ startDate, endDate, limit });
  }

  /**
   * 按时间范围分页查询会话列表（RPC get_chat_session_list，DB 侧聚合 + 搜索 + 游标裁剪）。
   *
   * 分页必须走游标而非 offset：会话按最后消息时间倒序，新消息会把会话顶到列表头，
   * offset 会整体漂移导致翻页出现重复/漏项。游标锚在 (lastTimestamp, chatId) 上不受影响。
   *
   * 同时避开了 PostgREST 的 max_rows(1000) 静默截断——先前一次性取全量，
   * 「近 30 天」实际有 5000+ 会话却只返回 1000 条且不报错。
   */
  async getChatSessionPage(query: ChatSessionPageQuery): Promise<ChatSessionPage> {
    if (!this.isAvailable()) {
      return { sessions: [], total: 0, nextCursor: null };
    }

    const limit = Math.max(1, Math.min(query.limit, MAX_SESSION_PAGE_SIZE));

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
          total_count: string;
        }>
      >('get_chat_session_list', {
        p_start_date: query.startDate.toISOString(),
        p_end_date: query.endDate.toISOString(),
        // 多取一条用于判断是否还有下一页，返回前裁掉
        p_limit: limit + 1,
        p_search: query.search?.trim() || null,
        p_cursor_timestamp: query.cursor?.timestamp ?? null,
        p_cursor_chat_id: query.cursor?.chatId ?? null,
      });

      if (!result || result.length === 0) {
        return { sessions: [], total: 0, nextCursor: null };
      }

      const total = parseInt(result[0].total_count, 10) || 0;
      const hasMore = result.length > limit;
      const pageRows = hasMore ? result.slice(0, limit) : result;

      const sessions = pageRows.map((item) => ({
        chatId: item.chat_id,
        candidateName: item.candidate_name,
        managerName: item.manager_name,
        messageCount: parseInt(item.message_count, 10),
        lastMessage: item.last_message,
        lastTimestamp: item.last_timestamp ? new Date(item.last_timestamp).getTime() : undefined,
        avatar: item.avatar,
        contactType: item.contact_type,
      }));

      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && lastRow?.last_timestamp
          ? { timestamp: lastRow.last_timestamp, chatId: lastRow.chat_id }
          : null;

      return { sessions, total, nextCursor };
    } catch (error) {
      this.logger.error('获取会话列表(时间范围)失败:', error);
      return { sessions: [], total: 0, nextCursor: null };
    }
  }

  // ==================== 统计相关 ====================

  /**
   * 业务口径的每日趋势（永久表来源，供「消息趋势」面板与「全部」档）：
   * - message_count = 候选人消息 + AI 回复（daily_ops_report，逻辑消息，不计投递分段）
   * - session_count = 当日有业务事件的去重会话（ops_events）
   * 不受 chat_messages 保留期影响。
   */
  async getChatBusinessDailyTrend(
    startDate: string,
    endDate: string,
  ): Promise<Array<{ date: string; messageCount: number; sessionCount: number }>> {
    if (!this.isAvailable()) return [];
    try {
      const rows = await this.rpc<
        Array<{ date: string; message_count: number | string; session_count: number | string }>
      >('get_chat_business_daily_trend', { p_start_date: startDate, p_end_date: endDate });
      return (rows ?? []).map((r) => ({
        date: r.date,
        messageCount: Number(r.message_count) || 0,
        sessionCount: Number(r.session_count) || 0,
      }));
    } catch (error) {
      this.logger.error('获取业务口径每日趋势失败:', error);
      return [];
    }
  }

  /** 各业务表的数据覆盖起点（「全部」档的真实起点）。 */
  async getBusinessDataFloor(): Promise<{
    opsEventsFrom: string | null;
    dailyOpsReportFrom: string | null;
    userActivityFrom: string | null;
  }> {
    if (!this.isAvailable()) {
      return { opsEventsFrom: null, dailyOpsReportFrom: null, userActivityFrom: null };
    }
    try {
      const rows = await this.rpc<
        Array<{
          ops_events_from: string | null;
          daily_ops_report_from: string | null;
          user_activity_from: string | null;
        }>
      >('get_business_data_floor', {});
      const r = rows?.[0];
      return {
        opsEventsFrom: r?.ops_events_from ?? null,
        dailyOpsReportFrom: r?.daily_ops_report_from ?? null,
        userActivityFrom: r?.user_activity_from ?? null,
      };
    } catch (error) {
      this.logger.error('获取业务数据覆盖起点失败:', error);
      return { opsEventsFrom: null, dailyOpsReportFrom: null, userActivityFrom: null };
    }
  }

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
    // 视觉事实旁路（visual-fact-structuring §3.3）：与描述文本同一次 update 落
    // visual_facts jsonb，保证 sheet 与 content 永远同源成对（后写者赢，不撕裂）。
    visualFacts?: Record<string, unknown>,
  ): Promise<{ chatId: string | null }> {
    if (!this.isAvailable()) {
      return { chatId: null };
    }

    try {
      const patch: Record<string, unknown> = { content };
      if (visualFacts !== undefined) patch.visual_facts = visualFacts;
      const rows = await this.update<ChatMessageRecord>(patch, (q) =>
        q.eq('message_id', messageId),
      );
      return { chatId: rows[0]?.chat_id ?? null };
    } catch (error) {
      this.logger.error(`更新消息 content 失败 [${messageId}]:`, error);
      return { chatId: null };
    }
  }

  /**
   * 拉取会话内「描述缺失」的裸视觉消息（visual-fact-structuring 读时懒补写）。
   *
   * 人工接管、非托管或超时期间同步进历史的候选人图片可能没有经过 Agent 链路，
   * 因而只留下裸占位。托管恢复后按会话捞出这些图片，交给 ImageDescriptionService
   * 异步补写描述，使其在本轮或下一轮进入消息窗口。
   */
  async getBareVisualMessagesByChat(
    chatId: string,
    options?: { sinceTimestamp?: number; limit?: number },
  ): Promise<
    Array<{ messageId: string; content: string; payload: Record<string, unknown> | null }>
  > {
    if (!this.isAvailable()) return [];
    try {
      const results = await this.select<{
        message_id: string;
        content: string;
        payload: Record<string, unknown> | null;
      }>('message_id,content,payload', (q) => {
        let query = q
          .eq('chat_id', chatId)
          .eq('role', 'user')
          .in('content', [IMAGE_MESSAGE_PREFIX, EMOTION_MESSAGE_PREFIX]);
        if (options?.sinceTimestamp) {
          query = query.gte('timestamp', new Date(options.sinceTimestamp).toISOString());
        }
        return query.order('timestamp', { ascending: false }).limit(options?.limit ?? 5);
      });
      return results.map((row) => ({
        messageId: row.message_id,
        content: row.content,
        payload: row.payload,
      }));
    } catch (error) {
      this.logger.error(`拉取裸视觉消息失败 [${chatId}]:`, error);
      return [];
    }
  }

  /**
   * 拉取会话内视觉消息的结构化事实（visual-fact-structuring 消费侧读路径）。
   *
   * 供事实抽取/geocode 锚点按「剥时间后缀的窗口内容」匹配 sheet——消息窗口对象
   * 不携带 messageId 贯穿到抽取层，内容等值匹配是最小侵入的关联方式（描述由
   * updateMessageContent 整条写入，窗口读到的 content 与库中逐字一致）。
   */
  async getVisualFactsByChat(
    chatId: string,
    options?: { sinceTimestamp?: number; limit?: number },
  ): Promise<Array<{ content: string; visualFacts: Record<string, unknown> }>> {
    if (!this.isAvailable()) return [];
    try {
      const results = await this.select<{
        content: string;
        visual_facts: Record<string, unknown> | null;
      }>('content,visual_facts', (q) => {
        let query = q.eq('chat_id', chatId).not('visual_facts', 'is', null);
        if (options?.sinceTimestamp) {
          query = query.gte('timestamp', new Date(options.sinceTimestamp).toISOString());
        }
        return query.order('timestamp', { ascending: false }).limit(options?.limit ?? 40);
      });
      return results
        .filter((row) => row.visual_facts != null)
        .map((row) => ({ content: row.content, visualFacts: row.visual_facts! }));
    } catch (error) {
      this.logger.error(`拉取视觉事实失败 [${chatId}]:`, error);
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
