import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import { MessageProcessingRecordInput, MessageProcessingDbRecord } from '../types';

/**
 * 消息处理记录 Repository
 *
 * 负责管理 message_processing_records 表：
 * - 保存消息处理记录
 * - 查询消息处理统计
 * - 获取最慢消息
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
   * 获取最慢的消息（按 AI 处理耗时降序）
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
      const results = await this.select<MessageProcessingDbRecord>('*', (q) => {
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
    status?: 'processing' | 'success' | 'failure';
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buildModifier = (q: any) => {
        let r = q.order('received_at', { ascending: false });
        if (options.startTime) r = r.gte('received_at', new Date(options.startTime).toISOString());
        if (options.endTime) r = r.lte('received_at', new Date(options.endTime).toISOString());
        if (options.status) r = r.eq('status', options.status);
        if (options.limit) {
          const offset = options.offset ?? 0;
          r = r.range(offset, offset + options.limit - 1);
        }
        return r;
      };

      const results = await this.select<MessageProcessingDbRecord>('*', buildModifier);
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
   * 获取消息统计（数据库级聚合）
   * 只统计主消息（is_primary=true 或 is_primary=null 的旧数据）
   */
  async getMessageStats(
    startTime: number,
    endTime: number,
  ): Promise<{ total: number; success: number; failed: number; avgDuration: number }> {
    if (!this.isAvailable()) {
      return { total: 0, success: 0, failed: 0, avgDuration: 0 };
    }

    try {
      const startDate = new Date(startTime).toISOString();
      const endDate = new Date(endTime).toISOString();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buildPrimaryFilter = (q: any) =>
        q
          .gte('received_at', startDate)
          .lt('received_at', endDate)
          .or('is_primary.eq.true,is_primary.is.null');

      const [total, success, failed, avgDurationRecords] = await Promise.all([
        this.count(buildPrimaryFilter),
        this.count((q) => buildPrimaryFilter(q).eq('status', 'success')),
        this.count((q) => buildPrimaryFilter(q).in('status', ['failure', 'failed'])),
        this.select<{ ai_duration: number }>('ai_duration', (q) =>
          buildPrimaryFilter(q).eq('status', 'success').gt('ai_duration', 0).limit(1000),
        ),
      ]);

      const durations = avgDurationRecords
        .map((r) => r.ai_duration)
        .filter((d) => d !== null && d !== undefined && d > 0);

      const avgDuration =
        durations.length > 0
          ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
          : 0;

      return { total, success, failed, avgDuration };
    } catch (error) {
      this.logger.error('获取消息统计失败:', error);
      return { total: 0, success: 0, failed: 0, avgDuration: 0 };
    }
  }

  /**
   * 获取指定日期范围内的活跃用户（按 user_id 聚合）
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
      const results = await this.select<{
        user_id: string;
        user_name: string;
        chat_id: string;
        received_at: string;
        token_usage: number;
      }>('user_id,user_name,chat_id,received_at,token_usage', (q) =>
        q
          .gte('received_at', startDate.toISOString())
          .lte('received_at', endDate.toISOString())
          .eq('status', 'success')
          .order('received_at', { ascending: true }),
      );

      // 按 user_id 聚合
      const userMap = new Map<
        string,
        {
          userId: string;
          userName: string;
          chatId: string;
          messageCount: number;
          tokenUsage: number;
          firstActiveAt: number;
          lastActiveAt: number;
        }
      >();

      for (const row of results) {
        const userId = row.user_id;
        if (!userId) continue;

        const receivedAt = new Date(row.received_at).getTime();
        const tokenUsage = row.token_usage || 0;

        if (!userMap.has(userId)) {
          userMap.set(userId, {
            userId,
            userName: row.user_name || '',
            chatId: row.chat_id,
            messageCount: 1,
            tokenUsage,
            firstActiveAt: receivedAt,
            lastActiveAt: receivedAt,
          });
        } else {
          const user = userMap.get(userId)!;
          user.messageCount++;
          user.tokenUsage += tokenUsage;
          user.lastActiveAt = Math.max(user.lastActiveAt, receivedAt);
        }
      }

      return Array.from(userMap.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch (error) {
      this.logger.error('获取活跃用户失败:', error);
      return [];
    }
  }

  /**
   * 获取每日用户统计（按日期聚合）
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
      const results = await this.select<{
        user_id: string;
        received_at: string;
        token_usage: number;
      }>('user_id,received_at,token_usage', (q) =>
        q
          .gte('received_at', startDate.toISOString())
          .lte('received_at', endDate.toISOString())
          .eq('status', 'success')
          .order('received_at', { ascending: true }),
      );

      // 按日期聚合
      const dailyStats = new Map<
        string,
        { date: string; uniqueUsers: Set<string>; messageCount: number; tokenUsage: number }
      >();

      for (const row of results) {
        const dateKey = new Date(row.received_at).toISOString().split('T')[0];

        if (!dailyStats.has(dateKey)) {
          dailyStats.set(dateKey, {
            date: dateKey,
            uniqueUsers: new Set(),
            messageCount: 0,
            tokenUsage: 0,
          });
        }

        const stats = dailyStats.get(dateKey)!;
        if (row.user_id) stats.uniqueUsers.add(row.user_id);
        stats.messageCount++;
        stats.tokenUsage += row.token_usage || 0;
      }

      return Array.from(dailyStats.values()).map((s) => ({
        date: s.date,
        uniqueUsers: s.uniqueUsers.size,
        messageCount: s.messageCount,
        tokenUsage: s.tokenUsage,
      }));
    } catch (error) {
      this.logger.error('获取每日用户统计失败:', error);
      return [];
    }
  }

  /**
   * 按时间范围查询消息记录（轻量版，只查询 Dashboard 需要的字段）
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
        'ai_duration',
        'total_duration',
        'scenario',
        'tools',
        'token_usage',
        'is_fallback',
        'fallback_success',
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
      const result = await this.rpc<Array<{ cleanup_message_processing_records: string }>>(
        'cleanup_message_processing_records',
        { days_to_keep: retentionDays },
      );

      const deletedCount = parseInt(result?.[0]?.cleanup_message_processing_records ?? '0', 10);
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
      is_primary: record.isPrimary,
    };
  }

  /**
   * 从数据库记录格式转换
   */
  private fromDbRecord(record: MessageProcessingDbRecord): MessageProcessingRecordInput {
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
      status: record.status as 'processing' | 'success' | 'failure',
      error: record.error,
      scenario: record.scenario,
      totalDuration: record.total_duration,
      queueDuration: record.queue_duration,
      prepDuration: record.prep_duration,
      aiStartAt: record.ai_start_at,
      aiEndAt: record.ai_end_at,
      aiDuration: record.ai_duration,
      sendDuration: record.send_duration,
      tools: record.tools,
      tokenUsage: record.token_usage,
      isFallback: record.is_fallback,
      fallbackSuccess: record.fallback_success,
      agentInvocation: record.agent_invocation,
      batchId: record.batch_id,
      isPrimary: record.is_primary,
    };
  }
}
