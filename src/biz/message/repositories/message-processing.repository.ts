import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { MessageProcessingDbRecord } from '../entities/message-processing.entity';
import { MessageProcessingRecordInput } from '../types/message.types';

/**
 * 消息处理记录 Repository
 *
 * 负责管理 message_processing_records 表：
 * - 保存请求级处理流水
 * - 查询请求处理统计
 * - 获取最慢请求
 */
@Injectable()
export class MessageProcessingRepository extends BaseRepository {
  protected readonly tableName = 'message_processing_records';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // ==================== 消息处理记录 ====================

  /**
   * 保存消息处理记录
   */
  async saveMessageProcessingRecord(record: MessageProcessingRecordInput): Promise<boolean> {
    if (!this.isAvailable()) {
      this.logger.warn('[消息处理记录] Supabase 未初始化，跳过保存');
      return false;
    }

    try {
      const dbRecord = this.toDbRecord(record);

      await this.upsert(dbRecord, {
        onConflict: 'message_id',
        returnData: false,
      });

      this.logger.debug(`[消息处理记录] 已保存: ${record.messageId}`);
      return true;
    } catch (error) {
      this.logger.error(`[消息处理记录] 保存失败 [${record.messageId}]:`, error);
      return false;
    }
  }

  /**
   * 获取最慢的处理请求（按 AI 处理耗时降序）
   */
  async getSlowestMessages(
    startTime?: number,
    endTime?: number,
    limit: number = 10,
  ): Promise<MessageProcessingRecordInput[]> {
    if (!this.isAvailable()) {
      this.logger.warn('[最慢消息] Supabase 未初始化');
      return [];
    }

    try {
      const selectedColumns = [
        'message_id',
        'chat_id',
        'user_id',
        'user_name',
        'manager_name',
        'received_at',
        'message_preview',
        'reply_preview',
        'reply_segments',
        'status',
        'error',
        'alert_type',
        'scenario',
        'total_duration',
        'queue_duration',
        'prep_duration',
        'ai_duration',
        'ttft_ms:agent_invocation->response->timings->durations->>requestToFirstTextDeltaMs',
        'send_duration',
        'tools',
        'token_usage',
        'is_fallback',
        'fallback_success',
        'batch_id',
      ].join(',');

      const results = await this.select<MessageProcessingDbRecord>(selectedColumns, (q) => {
        let r = q
          .eq('status', 'success')
          .gt('ai_duration', 0)
          .order('ai_duration', { ascending: false })
          .limit(limit);
        if (startTime) r = r.gte('received_at', new Date(startTime).toISOString());
        if (endTime) r = r.lte('received_at', new Date(endTime).toISOString());
        return r;
      });

      return results.map((r) => this.fromDbRecord(r));
    } catch (error) {
      this.logger.error('[最慢消息] 查询失败:', error);
      return [];
    }
  }

  /**
   * 获取指定时间范围内的消息处理记录
   */
  async getMessageProcessingRecords(options: {
    startTime?: number;
    endTime?: number;
    startDate?: Date;
    endDate?: Date;
    status?: 'processing' | 'success' | 'failure' | 'timeout';
    chatId?: string;
    userName?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    records: MessageProcessingRecordInput[];
    total: number;
  }> {
    if (!this.isAvailable()) {
      return { records: [], total: 0 };
    }

    try {
      const selectedColumns = [
        'message_id',
        'chat_id',
        'user_id',
        'user_name',
        'manager_name',
        'received_at',
        'message_preview',
        'reply_preview',
        'reply_segments',
        'status',
        'error',
        'alert_type',
        'scenario',
        'total_duration',
        'queue_duration',
        'prep_duration',
        'ai_duration',
        'ttft_ms:agent_invocation->response->timings->durations->>requestToFirstTextDeltaMs',
        'send_duration',
        'tools',
        'token_usage',
        'is_fallback',
        'fallback_success',
        'batch_id',
      ].join(',');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buildModifier = (q: any) => {
        let r = q.order('received_at', { ascending: false });
        if (options.startDate) r = r.gte('received_at', options.startDate.toISOString());
        else if (options.startTime)
          r = r.gte('received_at', new Date(options.startTime).toISOString());
        if (options.endDate) r = r.lte('received_at', options.endDate.toISOString());
        else if (options.endTime) r = r.lte('received_at', new Date(options.endTime).toISOString());
        if (options.status) r = r.eq('status', options.status);
        if (options.chatId) r = r.eq('chat_id', options.chatId);
        if (options.userName) r = r.ilike('user_name', `%${options.userName}%`);
        if (options.limit) {
          const offset = options.offset ?? 0;
          r = r.range(offset, offset + options.limit - 1);
        }
        return r;
      };

      const results = await this.select<MessageProcessingDbRecord>(selectedColumns, buildModifier);
      const total = await this.count(buildModifier);

      return {
        records: results.map((r) => this.fromDbRecord(r)),
        total,
      };
    } catch (error) {
      this.logger.error('获取消息处理记录失败:', error);
      return { records: [], total: 0 };
    }
  }

  /**
   * 根据消息ID获取单条消息处理记录详情
   */
  async getMessageProcessingRecordById(
    messageId: string,
  ): Promise<MessageProcessingRecordInput | null> {
    if (!this.isAvailable()) {
      this.logger.warn('[消息处理记录] Supabase 未初始化，跳过查询');
      return null;
    }

    try {
      const results = await this.select<MessageProcessingDbRecord>('*', (q) =>
        q.eq('message_id', messageId).limit(1),
      );

      if (results.length === 0) {
        this.logger.debug(`[消息处理记录] 未找到 messageId: ${messageId}`);
        return null;
      }

      return this.fromDbRecord(results[0]);
    } catch (error) {
      this.logger.error(`[消息处理记录] 查询详情失败 (messageId: ${messageId}):`, error);
      return null;
    }
  }

  // ==================== 聚合查询 ====================

  /**
   * 获取请求统计（数据库级聚合）
   */
  async getMessageStats(
    startTime: number,
    endTime: number,
  ): Promise<{ total: number; success: number; failed: number; avgDuration: number; avgTtft: number }> {
    if (!this.isAvailable()) {
      return { total: 0, success: 0, failed: 0, avgDuration: 0, avgTtft: 0 };
    }

    try {
      const result = await this.rpc<
        Array<{
          total_messages: string | number;
          success_count: string | number;
          failure_count: string | number;
          avg_duration: string | number;
          avg_ttft?: string | number | null;
        }>
      >('get_dashboard_overview_stats', {
        p_start_date: new Date(startTime).toISOString(),
        p_end_date: new Date(endTime).toISOString(),
      });

      const row = result?.[0];
      if (!row) {
        return { total: 0, success: 0, failed: 0, avgDuration: 0, avgTtft: 0 };
      }

      return {
        total: Number(row.total_messages) || 0,
        success: Number(row.success_count) || 0,
        failed: Number(row.failure_count) || 0,
        avgDuration: Math.round(Number(row.avg_duration) || 0),
        avgTtft: Math.round(Number(row.avg_ttft) || 0),
      };
    } catch (error) {
      this.logger.error('获取消息统计失败:', error);
      return { total: 0, success: 0, failed: 0, avgDuration: 0, avgTtft: 0 };
    }
  }

  /**
   * 获取指定日期范围内的活跃用户（按 user_id 聚合）
   * 使用 RPC get_active_users_by_range，在数据库侧完成聚合，避免拉取全量数据到内存。
   */
  async getActiveUsers(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      userId: string;
      userName: string;
      chatId: string;
      messageCount: number;
      tokenUsage: number;
      firstActiveAt: number;
      lastActiveAt: number;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          user_id: string;
          user_name: string;
          chat_id: string;
          message_count: string;
          token_usage: string;
          first_active_at: string;
          last_active_at: string;
        }>
      >('get_active_users_by_range', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) return [];

      return result.map((row) => ({
        userId: row.user_id,
        userName: row.user_name || '',
        chatId: row.chat_id,
        messageCount: parseInt(row.message_count, 10),
        tokenUsage: parseInt(row.token_usage, 10),
        firstActiveAt: new Date(row.first_active_at).getTime(),
        lastActiveAt: new Date(row.last_active_at).getTime(),
      }));
    } catch (error) {
      this.logger.error('获取活跃用户失败:', error);
      return [];
    }
  }

  /**
   * 获取每日用户统计（按日期聚合）
   * 使用 RPC get_daily_user_stats_by_range，在数据库侧完成聚合，避免拉取全量数据到内存。
   */
  async getDailyUserStats(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      date: string;
      uniqueUsers: number;
      messageCount: number;
      tokenUsage: number;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          stat_date: string;
          unique_users: string;
          message_count: string;
          token_usage: string;
        }>
      >('get_daily_user_stats_by_range', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) return [];

      return result.map((row) => ({
        date: row.stat_date,
        uniqueUsers: parseInt(row.unique_users, 10),
        messageCount: parseInt(row.message_count, 10),
        tokenUsage: parseInt(row.token_usage, 10),
      }));
    } catch (error) {
      this.logger.error('获取每日用户统计失败:', error);
      return [];
    }
  }

  /**
   * 按时间范围查询处理请求记录（轻量版，只查询 Dashboard 需要的字段）
   */
  async getRecordsByTimeRange(
    startTime: number,
    endTime: number,
    limit: number = 2000,
  ): Promise<MessageProcessingRecordInput[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const startDate = new Date(startTime).toISOString();
      const endDate = new Date(endTime).toISOString();

      const selectedColumns = [
        'message_id',
        'chat_id',
        'user_id',
        'user_name',
        'manager_name',
        'received_at',
        'message_preview',
        'reply_preview',
        'status',
        'alert_type',
        'ai_duration',
        'total_duration',
        'scenario',
        'tools',
        'token_usage',
        'is_fallback',
        'fallback_success',
        'agent_invocation',
        'batch_id',
      ].join(',');

      const results = await this.select<MessageProcessingDbRecord>(selectedColumns, (q) =>
        q
          .gte('received_at', startDate)
          .lt('received_at', endDate)
          .order('received_at', { ascending: false })
          .limit(limit),
      );

      return results.map((r) => this.fromDbRecord(r));
    } catch (error) {
      this.logger.error('按时间范围查询消息记录失败:', error);
      return [];
    }
  }

  // ==================== 清理方法 ====================

  /**
   * 清理过期消息处理记录
   * 调用数据库 RPC 函数 cleanup_message_processing_records
   * @param retentionDays 保留天数
   * @returns 删除的记录数
   */
  async cleanupMessageProcessingRecords(retentionDays: number): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const result = await this.rpc<Array<{ deleted_count: string }>>(
        'cleanup_message_processing_records',
        { days_to_keep: retentionDays },
      );

      const deletedCount = parseInt(result?.[0]?.deleted_count ?? '0', 10);
      return deletedCount;
    } catch (error) {
      this.logger.error(`[消息处理记录] 清理失败:`, error);
      throw error;
    }
  }

  /**
   * 将过期的 agent_invocation 字段置为 NULL（释放 TOAST 空间）
   * @param daysOld 超过多少天的记录将被清理
   * @returns 更新的记录数
   */
  async nullAgentInvocations(daysOld: number = 7): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const result = await this.rpc<Array<{ null_agent_invocation: string }>>(
        'null_agent_invocation',
        { p_days_old: daysOld },
      );

      const updatedCount = parseInt(result?.[0]?.null_agent_invocation ?? '0', 10);
      return updatedCount;
    } catch (error) {
      this.logger.error(`[消息处理记录] NULL agent_invocation 失败:`, error);
      throw error;
    }
  }

  /**
   * 将超时的 processing 记录标记为 timeout
   * 用于兜底清理长期停留在 processing 状态的请求记录
   * @param stuckMinutes 超过多少分钟的 processing 记录视为卡住（默认 30 分钟）
   * @returns 更新的记录数
   */
  async timeoutStuckRecords(stuckMinutes = 30): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const cutoff = new Date(Date.now() - stuckMinutes * 60 * 1000).toISOString();
      const client = this.getClient();
      const { data, error } = await client
        .from(this.tableName)
        .update({
          status: 'timeout',
          error: `处理超时（超过 ${stuckMinutes} 分钟未完成）`,
        })
        .eq('status', 'processing')
        .lt('received_at', cutoff)
        .select('message_id');

      if (error) {
        this.logger.error(`[消息处理记录] 超时标记失败:`, error);
        return 0;
      }

      return data?.length ?? 0;
    } catch (error) {
      this.logger.error(`[消息处理记录] 超时标记异常:`, error);
      return 0;
    }
  }

  /**
   * 按 message_id 直接更新状态（不依赖完整记录）
   * 用于极端情况下的最小状态修正
   */
  async updateStatusByMessageId(
    messageId: string,
    updates: {
      status: 'success' | 'failure';
      error?: string;
      alertType?: MessageProcessingRecordInput['alertType'];
      scenario?: string;
      tokenUsage?: number;
      replyPreview?: string;
      replySegments?: number;
      isFallback?: boolean;
      fallbackSuccess?: boolean;
      batchId?: string;
    },
  ): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const dbUpdates: Record<string, unknown> = { status: updates.status };
      if (updates.error !== undefined) dbUpdates.error = updates.error;
      if (updates.alertType !== undefined) dbUpdates.alert_type = updates.alertType;
      if (updates.scenario !== undefined) dbUpdates.scenario = updates.scenario;
      if (updates.tokenUsage !== undefined) dbUpdates.token_usage = updates.tokenUsage;
      if (updates.replyPreview !== undefined) dbUpdates.reply_preview = updates.replyPreview;
      if (updates.replySegments !== undefined) dbUpdates.reply_segments = updates.replySegments;
      if (updates.isFallback !== undefined) dbUpdates.is_fallback = updates.isFallback;
      if (updates.fallbackSuccess !== undefined)
        dbUpdates.fallback_success = updates.fallbackSuccess;
      if (updates.batchId !== undefined) dbUpdates.batch_id = updates.batchId;

      const { error } = await this.getClient()
        .from(this.tableName)
        .update(dbUpdates)
        .eq('message_id', messageId)
        .eq('status', 'processing');

      if (error) {
        this.logger.error(`[消息处理记录] 直接更新状态失败 [${messageId}]:`, error);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(`[消息处理记录] 直接更新状态异常 [${messageId}]:`, error);
      return false;
    }
  }

  /**
   * 清空所有消息处理记录（危险操作）
   */
  async clearAllRecords(): Promise<void> {
    if (!this.isAvailable()) return;
    await this.delete((q) => q.gte('received_at', '1970-01-01'));
    this.logger.warn('[消息处理记录] 已清空所有数据库记录');
  }

  // ==================== 私有方法 ====================

  /**
   * 转换为数据库记录格式
   */
  private toDbRecord(record: MessageProcessingRecordInput): MessageProcessingDbRecord {
    return {
      message_id: record.messageId,
      chat_id: record.chatId,
      user_id: record.userId,
      user_name: record.userName,
      manager_name: record.managerName,
      received_at: new Date(record.receivedAt).toISOString(),
      message_preview: record.messagePreview,
      reply_preview: record.replyPreview,
      reply_segments: record.replySegments,
      status: record.status,
      error: record.error,
      alert_type: record.alertType,
      scenario: record.scenario,
      total_duration: record.totalDuration,
      queue_duration: record.queueDuration,
      prep_duration: record.prepDuration,
      ai_start_at: record.aiStartAt,
      ai_end_at: record.aiEndAt,
      ai_duration: record.aiDuration,
      send_duration: record.sendDuration,
      tools: record.tools,
      token_usage: record.tokenUsage,
      is_fallback: record.isFallback,
      fallback_success: record.fallbackSuccess,
      agent_invocation: record.agentInvocation,
      batch_id: record.batchId,
    };
  }

  /**
   * 从数据库记录格式转换
   */
  private fromDbRecord(record: MessageProcessingDbRecord): MessageProcessingRecordInput {
    const ttftMs = this.extractTtftMs(record);

    return {
      messageId: record.message_id,
      chatId: record.chat_id,
      userId: record.user_id,
      userName: record.user_name,
      managerName: record.manager_name,
      receivedAt: new Date(record.received_at).getTime(),
      messagePreview: record.message_preview,
      replyPreview: record.reply_preview,
      replySegments: record.reply_segments,
      status: record.status as 'processing' | 'success' | 'failure' | 'timeout',
      error: record.error,
      alertType: record.alert_type as MessageProcessingRecordInput['alertType'],
      scenario: record.scenario,
      totalDuration: record.total_duration,
      queueDuration: record.queue_duration,
      prepDuration: record.prep_duration,
      aiStartAt: record.ai_start_at,
      aiEndAt: record.ai_end_at,
      aiDuration: record.ai_duration,
      ttftMs,
      sendDuration: record.send_duration,
      tools: record.tools,
      tokenUsage: record.token_usage,
      isFallback: record.is_fallback,
      fallbackSuccess: record.fallback_success,
      agentInvocation: record.agent_invocation,
      batchId: record.batch_id,
    };
  }

  private extractTtftMs(record: MessageProcessingDbRecord): number | undefined {
    const fromProjection = this.parseNumber(record.ttft_ms);
    if (fromProjection !== undefined) return fromProjection;

    const agentInvocation = record.agent_invocation as
      | {
          response?: {
            timings?: {
              durations?: {
                requestToFirstTextDeltaMs?: unknown;
              };
            };
          };
        }
      | undefined;

    return this.parseNumber(
      agentInvocation?.response?.timings?.durations?.requestToFirstTextDeltaMs,
    );
  }

  private parseNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }
}
