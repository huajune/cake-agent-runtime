import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { formatLocalDate } from '@infra/utils/date.util';
import { UserHostingStatus } from '../entities/user-hosting-status.entity';
import { DailyUserActivityStats, UserActivityAggregate, UserProfile } from '../types/user.types';

/**
 * 用户托管状态 Repository
 *
 * 纯数据访问层，仅负责：
 * - user_hosting_status 表的 CRUD 操作
 * - user_activity 表的查询与 RPC 调用
 *
 * 缓存和业务编排逻辑由 UserHostingService 负责。
 */
@Injectable()
export class UserHostingRepository extends BaseRepository {
  protected readonly tableName = 'user_hosting_status';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // ==================== user_hosting_status 操作 ====================

  /**
   * 查询所有生效中的暂停用户 ID、暂停时间、解禁时间与永久标记
   *
   * 返回永久暂停（is_permanent = true）或未过期（pause_expires_at > now()）的记录；
   * 过期的临时暂停由 expirePausedUsers 回写恢复。
   */
  async findPausedUserIds(): Promise<
    {
      user_id: string;
      paused_at: string;
      pause_expires_at: string | null;
      is_permanent: boolean | null;
      pause_reason: string | null;
    }[]
  > {
    const nowIso = new Date().toISOString();
    return this.select<{
      user_id: string;
      paused_at: string;
      pause_expires_at: string | null;
      is_permanent: boolean | null;
      pause_reason: string | null;
    }>('user_id,paused_at,pause_expires_at,is_permanent,pause_reason', (q) =>
      q
        .eq('is_paused', true)
        .or(`is_permanent.eq.true,pause_expires_at.gt.${nowIso}`)
        .order('paused_at', { ascending: false }),
    );
  }

  /**
   * UPSERT 暂停状态（按 user_id 冲突时更新），同时写入解禁时间、永久标记与理由
   *
   * 永久暂停时 pauseExpiresAt 传 null。
   */
  async upsertPause(
    userId: string,
    params: {
      pausedAt: string;
      pauseExpiresAt: string | null;
      isPermanent: boolean;
      reason?: string;
    },
  ): Promise<void> {
    await this.upsert(
      {
        user_id: userId,
        is_paused: true,
        paused_at: params.pausedAt,
        pause_expires_at: params.pauseExpiresAt,
        is_permanent: params.isPermanent,
        pause_reason: params.reason ?? null,
        pause_count: 1,
      },
      { onConflict: 'user_id', returnData: false },
    );
  }

  /**
   * 更新用户为恢复托管状态（清空解禁时间、永久标记与理由）
   */
  async updateResume(userId: string): Promise<void> {
    await this.update<UserHostingStatus>(
      {
        is_paused: false,
        resumed_at: new Date().toISOString(),
        pause_expires_at: null,
        is_permanent: false,
        pause_reason: null,
      },
      (q) => q.eq('user_id', userId),
    );
  }

  /**
   * 批量将已过期（pause_expires_at <= now()）的临时暂停记录回写为恢复状态
   * 永久暂停（is_permanent = true）不参与自动解禁。
   * 返回被回写的 user_id 列表，供调用方做日志或缓存清理。
   */
  async expirePausedUsers(): Promise<string[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.getClient()
      .from(this.tableName)
      .update({
        is_paused: false,
        resumed_at: nowIso,
        pause_expires_at: null,
      })
      .eq('is_paused', true)
      .eq('is_permanent', false)
      .lte('pause_expires_at', nowIso)
      .select('user_id');

    if (error) {
      this.handleError('EXPIRE_PAUSED', error);
      return [];
    }

    return ((data as { user_id: string }[]) ?? []).map((row) => row.user_id);
  }

  // ==================== user_activity 操作 ====================

  /**
   * 查询指定用户 ID 列表的资料（od_name、group_name、托管 bot 身份）
   */
  async findUserProfiles(userIds: string[]): Promise<UserProfile[]> {
    if (userIds.length === 0) {
      return [];
    }

    const { data, error } = await this.getClient()
      .from('user_activity')
      .select('chat_id,od_name,group_name,bot_user_id,im_bot_id')
      .in('chat_id', userIds)
      .order('last_active_at', { ascending: false });

    if (error) {
      this.handleError('SELECT from user_activity', error);
      return [];
    }

    const rows =
      (data as {
        chat_id: string;
        od_name?: string;
        group_name?: string;
        bot_user_id?: string;
        im_bot_id?: string;
      }[]) ?? [];
    return rows.map((row) => ({
      chatId: row.chat_id,
      odName: row.od_name,
      groupName: row.group_name,
      botUserId: row.bot_user_id,
      imBotId: row.im_bot_id,
    }));
  }

  /**
   * 按日期范围聚合查询活跃用户（通过 RPC get_active_users_from_user_activity_by_range）
   *
   * 数据源为 user_activity（按天聚合表），时区口径与写入侧对齐（Asia/Shanghai）。
   */
  async findActiveUsersByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<UserActivityAggregate[]> {
    // 列表型 RPC（RETURNS TABLE）经 PostgREST 受 max_rows(默认 1000) 限制：单次调用在活跃用户
    // 超 1000 时会被截断，导致托管用户列表与「列表长度型」计数都停在 1000。RPC 内已稳定 ORDER BY，
    // 经 rpcAllPaged 按 range 分页拉全量（统一受熔断器保护）。卡片纯计数请走
    // countActiveUsersByDateRange（DB 侧 COUNT，无截断）。
    const rows = await this.rpcAllPaged<{
      chat_id: string;
      od_id: string | null;
      od_name: string | null;
      group_id: string | null;
      group_name: string | null;
      bot_user_id: string | null;
      im_bot_id: string | null;
      message_count: string;
      token_usage: string;
      first_active_at: string;
      last_active_at: string;
    }>('get_active_users_from_user_activity_by_range', {
      p_start_date: startDate.toISOString(),
      p_end_date: endDate.toISOString(),
    });

    return rows.map((row) => ({
      chatId: row.chat_id,
      odId: row.od_id ?? undefined,
      odName: row.od_name ?? undefined,
      groupId: row.group_id ?? undefined,
      groupName: row.group_name ?? undefined,
      botUserId: row.bot_user_id ?? undefined,
      imBotId: row.im_bot_id ?? undefined,
      messageCount: parseInt(row.message_count, 10),
      tokenUsage: parseInt(row.token_usage, 10),
      firstActiveAt: new Date(row.first_active_at).getTime(),
      lastActiveAt: new Date(row.last_active_at).getTime(),
    }));
  }

  /**
   * 按日期范围 + 小组过滤，分页拉取去重 chat_id 集合（Dashboard 小组筛选用）。
   *
   * 直接把 group_name 过滤下推到 DB 并分页，避开列表型 RPC 的 PostgREST max_rows(默认 1000)
   * 截断——否则活跃用户超 1000 时本小组靠后的 chat_id 会被丢掉，导致小组活跃数 / chatIds /
   * 后续消息统计被低估。一个 chat_id 在多天会有多行，靠 Set 去重；按 (activity_date, chat_id)
   * 稳定排序分页，不会漏行。
   */
  async findActiveChatIdsByGroups(
    startDate: Date,
    endDate: Date,
    groups: string[],
  ): Promise<Set<string>> {
    const chatIds = new Set<string>();
    if (groups.length === 0) {
      return chatIds;
    }

    const start = formatLocalDate(startDate);
    const end = formatLocalDate(endDate);

    // 经 selectAllPaged 分页拉全量（统一受熔断器保护），避免活跃用户超 max_rows 时本小组靠后的
    // chat_id 被截断；一个 chat_id 多天多行靠 Set 去重；按 (activity_date, chat_id) 稳定排序分页。
    const rows = await this.selectAllPaged<{ chat_id: string | null }>(
      'user_activity',
      'chat_id',
      (q) =>
        q
          .in('group_name', groups)
          .gte('activity_date', start)
          .lte('activity_date', end)
          .order('activity_date', { ascending: true })
          .order('chat_id', { ascending: true }),
    );

    for (const row of rows) {
      if (row.chat_id) {
        chatIds.add(row.chat_id);
      }
    }

    return chatIds;
  }

  /**
   * 按日期范围统计去重活跃用户数。
   *
   * 列表型 RPC 会受 Supabase/PostgREST max_rows 限制；Dashboard 卡片只需要总数，
   * 因此走数据库侧 COUNT(DISTINCT chat_id)，避免真实用户数超过 1000 时被截断。
   */
  async countActiveUsersByDateRange(startDate: Date, endDate: Date): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const result = await this.rpc<number | string>(
        'count_active_users_from_user_activity_by_range',
        {
          p_start_date: startDate.toISOString(),
          p_end_date: endDate.toISOString(),
        },
      );

      if (result !== null && result !== undefined) {
        const count = Number(result);
        if (Number.isFinite(count)) {
          return count;
        }
      }

      return this.countActiveUsersByDateRangeFromTable(startDate, endDate);
    } catch (error) {
      this.logger.error('统计 user_activity 活跃用户数失败', error);
      return this.countActiveUsersByDateRangeFromTable(startDate, endDate);
    }
  }

  private async countActiveUsersByDateRangeFromTable(
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    const start = formatLocalDate(startDate);
    const end = formatLocalDate(endDate);
    const chatIds = new Set<string>();

    const rows = await this.selectAllPaged<{ chat_id: string | null }>(
      'user_activity',
      'chat_id',
      (q) =>
        q
          .gte('activity_date', start)
          .lte('activity_date', end)
          .order('activity_date', { ascending: true })
          .order('chat_id', { ascending: true }),
    );

    for (const row of rows) {
      if (row.chat_id) {
        chatIds.add(row.chat_id);
      }
    }

    return chatIds.size;
  }

  /**
   * 按天聚合 user_activity。
   *
   * Dashboard / users 页面展示的是长期趋势；message_processing_records 只保留短期流水，
   * 所以这里直接读按天保留的活跃表，并用分页避开 PostgREST 默认 1000 行限制。
   */
  async findDailyActivityStatsByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<DailyUserActivityStats[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const start = formatLocalDate(startDate);
    const end = formatLocalDate(endDate);
    const buckets = new Map<string, DailyUserActivityStats>();

    const rows = await this.selectAllPaged<{
      activity_date: string;
      chat_id: string;
      message_count: number | null;
      token_usage: number | null;
    }>('user_activity', 'activity_date,chat_id,message_count,token_usage', (q) =>
      q
        .gte('activity_date', start)
        .lte('activity_date', end)
        .order('activity_date', { ascending: true })
        .order('chat_id', { ascending: true }),
    );

    for (const row of rows) {
      const date = row.activity_date;
      const bucket =
        buckets.get(date) ??
        ({
          date,
          userCount: 0,
          messageCount: 0,
          tokenUsage: 0,
        } satisfies DailyUserActivityStats);

      bucket.userCount += 1;
      bucket.messageCount += row.message_count ?? 0;
      bucket.tokenUsage += row.token_usage ?? 0;
      buckets.set(date, bucket);
    }

    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 更新用户活跃记录（通过 RPC upsert_user_activity）
   */
  async upsertUserActivity(data: {
    chatId: string;
    odId?: string;
    odName?: string;
    groupId?: string;
    groupName?: string;
    botUserId?: string;
    imBotId?: string;
    messageCount?: number;
    totalTokens?: number;
    activeAt?: Date;
  }): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.rpc('upsert_user_activity', {
        p_chat_id: data.chatId,
        p_od_id: data.odId || null,
        p_od_name: data.odName || null,
        p_group_id: data.groupId || null,
        p_group_name: data.groupName || null,
        p_message_count: data.messageCount ?? 1,
        p_token_usage: data.totalTokens ?? 0,
        p_active_at: (data.activeAt ?? new Date()).toISOString(),
        p_bot_user_id: data.botUserId || null,
        p_im_bot_id: data.imBotId || null,
      });
    } catch (error) {
      this.logger.error('更新用户活跃记录失败', error);
    }
  }

  /**
   * 清理过期的用户活跃记录（通过 RPC cleanup_user_activity）
   */
  async cleanupUserActivity(retentionDays: number = 14): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const result = await this.rpc<number>('cleanup_user_activity', {
        retention_days: retentionDays,
      });

      const deletedCount = result ?? 0;
      if (deletedCount > 0) {
        this.logger.log(
          `用户活跃记录清理完成: 删除 ${deletedCount} 条 ${retentionDays} 天前的记录`,
        );
      }
      return deletedCount;
    } catch (error) {
      this.logger.error('清理用户活跃记录失败', error);
      return 0;
    }
  }
}
