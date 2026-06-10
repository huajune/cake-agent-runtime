import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { MessageProcessingDbRecord } from '../entities/message-processing.entity';
import { MessageProcessingRecordInput } from '../types/message.types';

interface MessageProcessingFilters {
  userName?: string;
  managerNames?: string[];
}

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

  // 列表/聚合查询用的精简投影（不拉 agent_invocation 这个 jsonb 大字段）
  private readonly listSelectedColumns = [
    'message_id',
    'chat_id',
    'user_id',
    'user_name',
    'manager_name',
    'bot_im_id',
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
    'tool_calls',
    'agent_steps',
    'anomaly_flags',
    'memory_snapshot',
    'post_processing_status',
    'token_usage',
    'is_fallback',
    'fallback_success',
    'batch_id',
  ].join(',');

  // 详情接口投影：在列表列基础上多带 agent_invocation，前端详情抽屉的时延分解、
  // 工具执行、Trace、Delivery、Fallback 等富字段全部依赖该 jsonb。
  private readonly detailSelectedColumns = `${this.listSelectedColumns},agent_invocation`;

  // Dashboard 业务趋势只需要时间、用户和预约工具调用结果，避免为图表拉取大块快照字段。
  private readonly businessTrendSelectedColumns = [
    'message_id',
    'received_at',
    'user_id',
    'tool_calls',
  ].join(',');

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
    filters?: MessageProcessingFilters,
  ): Promise<MessageProcessingRecordInput[]> {
    if (!this.isAvailable()) {
      this.logger.warn('[最慢消息] Supabase 未初始化');
      return [];
    }

    try {
      const results = await this.select<MessageProcessingDbRecord>(
        this.listSelectedColumns,
        (q) => {
          let r = q
            .eq('status', 'success')
            .gt('ai_duration', 0)
            .order('ai_duration', { ascending: false })
            .limit(limit);
          if (startTime) r = r.gte('received_at', new Date(startTime).toISOString());
          if (endTime) r = r.lte('received_at', new Date(endTime).toISOString());
          r = this.applyTextFilters(r, filters);
          return r;
        },
      );

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
    /** 多 chatId 过滤（小组筛选下推 DB，避免先 limit 截断再内存过滤导致小组指标被低估）。 */
    chatIds?: string[];
    userName?: string;
    managerNames?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{
    records: MessageProcessingRecordInput[];
    total: number;
  }> {
    if (!this.isAvailable()) {
      return { records: [], total: 0 };
    }

    // 大群筛选时 chatIds 可能上千：单条 .in('chat_id', [...]) 会把全部 id 编进 GET query string，
    // 触发 PostgREST/Cloudflare 的 URI 长度上限（414/520），错误被吞后静默返回空、仪表盘归零。
    // 超过批量阈值时分批查询再合并去重，避免 URL 超长。
    if (options.chatIds && options.chatIds.length > MessageProcessingRepository.CHAT_ID_IN_BATCH) {
      return this.getRecordsByChatIdBatches(options);
    }

    try {
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
        if (options.chatIds && options.chatIds.length > 0) r = r.in('chat_id', options.chatIds);
        r = this.applyTextFilters(r, {
          userName: options.userName,
          managerNames: options.managerNames,
        });
        if (options.limit) {
          const offset = options.offset ?? 0;
          r = r.range(offset, offset + options.limit - 1);
        }
        return r;
      };

      const results = await this.select<MessageProcessingDbRecord>(
        this.listSelectedColumns,
        buildModifier,
      );
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

  /** chatIds 单批上限：超过则分批 .in() 查询，避免 GET query string 触发 URI 长度上限。 */
  private static readonly CHAT_ID_IN_BATCH = 300;

  /**
   * chatIds 超量时分批查询并合并：每批走常规 getMessageProcessingRecords（batch <= 阈值，不再递归），
   * 按 messageId 去重、按 receivedAt 倒序，最后按 limit 截断。total 为各批之和（近似上界）。
   */
  private async getRecordsByChatIdBatches(options: {
    startTime?: number;
    endTime?: number;
    startDate?: Date;
    endDate?: Date;
    status?: 'processing' | 'success' | 'failure' | 'timeout';
    chatId?: string;
    chatIds?: string[];
    userName?: string;
    managerNames?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{ records: MessageProcessingRecordInput[]; total: number }> {
    const chatIds = options.chatIds ?? [];
    const batchSize = MessageProcessingRepository.CHAT_ID_IN_BATCH;
    const batches: string[][] = [];
    for (let i = 0; i < chatIds.length; i += batchSize) {
      batches.push(chatIds.slice(i, i + batchSize));
    }

    // offset 在分批合并语义下无法精确，统一从 0 取再内存截断；调用方（小组筛选）只用 limit。
    const perBatch = { ...options, offset: undefined };
    const results = await Promise.all(
      batches.map((batch) => this.getMessageProcessingRecords({ ...perBatch, chatIds: batch })),
    );

    const merged = new Map<string, MessageProcessingRecordInput>();
    let total = 0;
    for (const result of results) {
      total += result.total;
      for (const record of result.records) {
        merged.set(record.messageId, record);
      }
    }

    let records = Array.from(merged.values()).sort((a, b) => b.receivedAt - a.receivedAt);
    if (options.limit && records.length > options.limit) {
      records = records.slice(0, options.limit);
    }

    return { records, total };
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
      const results = await this.select<MessageProcessingDbRecord>(
        this.detailSelectedColumns,
        (q) => q.eq('message_id', messageId).limit(1),
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
    filters?: MessageProcessingFilters,
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    avgDuration: number;
    avgTtft: number;
  }> {
    if (!this.isAvailable()) {
      return { total: 0, success: 0, failed: 0, avgDuration: 0, avgTtft: 0 };
    }

    try {
      if (this.hasTextFilters(filters)) {
        return this.getFilteredMessageStats(startTime, endTime, filters);
      }

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

      const results = await this.select<MessageProcessingDbRecord>(this.listSelectedColumns, (q) =>
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

  /**
   * Dashboard 业务趋势轻量查询：只取趋势构建需要的字段。
   */
  async getBusinessTrendRecordsByTimeRange(
    startTime: number,
    endTime: number,
    limit: number = 10000,
  ): Promise<MessageProcessingRecordInput[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const startDate = new Date(startTime).toISOString();
      const endDate = new Date(endTime).toISOString();

      const results = await this.select<MessageProcessingDbRecord>(
        this.businessTrendSelectedColumns,
        (q) =>
          q
            .gte('received_at', startDate)
            .lt('received_at', endDate)
            .order('received_at', { ascending: true })
            .limit(limit),
      );

      return results.map((r) => this.fromDbRecord(r));
    } catch (error) {
      this.logger.error('按时间范围查询业务趋势记录失败:', error);
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
   *
   * 分批执行：PostgREST 连接角色 authenticator 有 statement_timeout=8s，
   * 单次全量 UPDATE 数千行 TOAST 大字段必然超时（生产曾因此积压数周未清理）。
   * 每批 p_limit 行，循环到一批不满即清完；maxBatches 防御 RPC 异常时死循环。
   *
   * @param daysOld 超过多少天的记录将被清理
   * @returns 更新的记录数
   */
  async nullAgentInvocations(daysOld: number = 7, batchLimit: number = 200): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    const maxBatches = 100;
    let total = 0;
    let lastBatchCount = 0;
    try {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await this.rpc<number>('null_agent_invocation', {
          p_days_old: daysOld,
          p_limit: batchLimit,
        });
        lastBatchCount = this.asRpcCount(result, 'null_agent_invocation');
        total += lastBatchCount;
        if (lastBatchCount < batchLimit) break;
      }
      if (lastBatchCount === batchLimit) {
        this.logger.warn(
          `[消息处理记录] NULL agent_invocation 达到分批上限 ${maxBatches}×${batchLimit}，可能仍有积压，待下次清理继续`,
        );
      }
      return total;
    } catch (error) {
      this.logger.error(`[消息处理记录] NULL agent_invocation 失败 (已清理 ${total} 条):`, error);
      throw error;
    }
  }

  /**
   * 将卡死在 running 状态的 post_processing_status 标记为 interrupted。
   *
   * turn-end 记忆收尾中途进程被杀（发版 SIGTERM/崩溃）时终态永远不会落库，
   * 记录会永久显示"收尾进行中"。该方法由小时级 cron 兜底调用。
   *
   * @param staleMinutes 超过多少分钟仍为 running 视为已丢失（默认 30）
   * @returns 更新的记录数
   */
  async interruptStalePostProcessing(
    staleMinutes: number = 30,
    batchLimit: number = 200,
  ): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    const maxBatches = 20;
    let total = 0;
    let lastBatchCount = 0;
    try {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await this.rpc<number>('interrupt_stale_post_processing', {
          p_stale_minutes: staleMinutes,
          p_limit: batchLimit,
        });
        lastBatchCount = this.asRpcCount(result, 'interrupt_stale_post_processing');
        total += lastBatchCount;
        if (lastBatchCount < batchLimit) break;
      }
      if (lastBatchCount === batchLimit) {
        this.logger.warn(
          `[消息处理记录] 标记 interrupted 达到分批上限 ${maxBatches}×${batchLimit}，可能仍有积压，待下次清理继续`,
        );
      }
      return total;
    } catch (error) {
      this.logger.error(`[消息处理记录] 标记 interrupted 失败 (已标记 ${total} 条):`, error);
      throw error;
    }
  }

  /**
   * 解析 RPC 计数返回：returns integer 的函数 supabase-js 返回裸数字；
   * 兼容历史上 `[{ fn_name: '12' }]` 形态的行集返回。
   */
  private asRpcCount(result: unknown, fieldName: string): number {
    if (typeof result === 'number' && Number.isFinite(result)) return result;
    if (Array.isArray(result)) {
      const value = (result[0] as Record<string, unknown> | undefined)?.[fieldName];
      const parsed = Number(value ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const parsed = Number(result ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
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

  async updatePostProcessingStatus(
    messageId: string,
    status: MessageProcessingRecordInput['postProcessingStatus'],
  ): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const { error } = await this.getClient()
        .from(this.tableName)
        .update({
          post_processing_status: status,
        })
        .eq('message_id', messageId);

      if (error) {
        this.logger.error(`[消息处理记录] 更新后处理状态失败 [${messageId}]:`, error);
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(`[消息处理记录] 更新后处理状态异常 [${messageId}]:`, error);
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

  /**
   * 按 message_id 批量删除（用于聚合时回收源消息流水）
   * @returns 实际尝试删除的条数（Supabase 不返回受影响行数，按入参长度估算）
   */
  async deleteByMessageIds(messageIds: string[]): Promise<number> {
    if (!this.isAvailable() || messageIds.length === 0) return 0;
    await this.delete((q) => q.in('message_id', messageIds));
    return messageIds.length;
  }

  // ==================== 私有方法 ====================

  private hasTextFilters(filters?: MessageProcessingFilters): boolean {
    return Boolean(
      filters?.userName?.trim() || this.normalizeFilterValues(filters?.managerNames).length,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyTextFilters(query: any, filters?: MessageProcessingFilters) {
    let result = query;
    const userName = filters?.userName?.trim();
    if (userName) result = result.ilike('user_name', `%${userName}%`);

    const managerNames = this.normalizeFilterValues(filters?.managerNames);
    if (managerNames.length === 1) {
      return result.ilike('manager_name', `%${managerNames[0]}%`);
    }

    if (managerNames.length > 1) {
      const orFilter = managerNames
        .map((managerName) => `manager_name.ilike.%${this.escapeOrFilterValue(managerName)}%`)
        .join(',');
      return result.or(orFilter);
    }

    return result;
  }

  private normalizeFilterValues(values?: string[]): string[] {
    return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean)));
  }

  private escapeOrFilterValue(value: string): string {
    return value.replace(/[,()]/g, '');
  }

  private async getFilteredMessageStats(
    startTime: number,
    endTime: number,
    filters?: MessageProcessingFilters,
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    avgDuration: number;
    avgTtft: number;
  }> {
    const rows = await this.select<MessageProcessingDbRecord>(
      [
        'status',
        'total_duration',
        'ttft_ms:agent_invocation->response->timings->durations->>requestToFirstTextDeltaMs',
      ].join(','),
      (q) => {
        let r = q
          .gte('received_at', new Date(startTime).toISOString())
          .lt('received_at', new Date(endTime).toISOString());
        r = this.applyTextFilters(r, filters);
        return r;
      },
    );

    let success = 0;
    let failed = 0;
    let durationSum = 0;
    let durationCount = 0;
    let ttftSum = 0;
    let ttftCount = 0;

    for (const row of rows) {
      if (row.status === 'success') success += 1;
      else failed += 1;

      const duration = this.parseNumber(row.total_duration);
      if (duration !== undefined && duration > 0) {
        durationSum += duration;
        durationCount += 1;
      }

      const ttft = this.extractTtftMs(row);
      if (ttft !== undefined && ttft > 0) {
        ttftSum += ttft;
        ttftCount += 1;
      }
    }

    return {
      total: rows.length,
      success,
      failed,
      avgDuration: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
      avgTtft: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
    };
  }

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
      bot_im_id: record.botImId,
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
      token_usage: record.tokenUsage,
      is_fallback: record.isFallback,
      fallback_success: record.fallbackSuccess,
      agent_invocation: record.agentInvocation,
      batch_id: record.batchId,
      tool_calls: record.toolCalls,
      agent_steps: record.agentSteps,
      anomaly_flags: record.anomalyFlags,
      memory_snapshot: record.memorySnapshot,
      post_processing_status: record.postProcessingStatus,
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
      botImId: record.bot_im_id,
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
      tokenUsage: record.token_usage,
      isFallback: record.is_fallback,
      fallbackSuccess: record.fallback_success,
      agentInvocation: record.agent_invocation,
      batchId: record.batch_id,
      toolCalls: record.tool_calls as MessageProcessingRecordInput['toolCalls'],
      agentSteps: record.agent_steps as MessageProcessingRecordInput['agentSteps'],
      anomalyFlags: record.anomaly_flags as MessageProcessingRecordInput['anomalyFlags'],
      memorySnapshot: record.memory_snapshot as MessageProcessingRecordInput['memorySnapshot'],
      postProcessingStatus:
        record.post_processing_status as MessageProcessingRecordInput['postProcessingStatus'],
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
