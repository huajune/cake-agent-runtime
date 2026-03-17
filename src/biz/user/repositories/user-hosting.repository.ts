import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { UserHostingStatus } from '../entities/user-hosting-status.entity';
import { UserProfile } from '../types/user.types';

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
   * 查询所有处于暂停状态的用户 ID 及暂停时间
   */
  async findPausedUserIds(): Promise<{ user_id: string; paused_at: string }[]> {
    return this.select<{ user_id: string; paused_at: string }>('user_id,paused_at', (q) =>
      q.eq('is_paused', true).order('paused_at', { ascending: false }),
    );
  }

  /**
   * UPSERT 暂停状态（按 user_id 冲突时更新）
   */
  async upsertPause(userId: string, pausedAt: string): Promise<void> {
    await this.upsert(
      {
        user_id: userId,
        is_paused: true,
        paused_at: pausedAt,
        pause_count: 1,
      },
      { onConflict: 'user_id', returnData: false },
    );
  }

  /**
   * 更新用户为恢复托管状态
   */
  async updateResume(userId: string): Promise<void> {
    await this.update<UserHostingStatus>(
      { is_paused: false, resumed_at: new Date().toISOString() },
      (q) => q.eq('user_id', userId),
    );
  }

  // ==================== user_activity 操作 ====================

  /**
   * 查询指定用户 ID 列表的资料（od_name、group_name）
   */
  async findUserProfiles(userIds: string[]): Promise<UserProfile[]> {
    if (userIds.length === 0) {
      return [];
    }

    const { data, error } = await this.getClient()
      .from('user_activity')
      .select('chat_id,od_name,group_name')
      .in('chat_id', userIds)
      .order('last_active_at', { ascending: false });

    if (error) {
      this.handleError('SELECT from user_activity', error);
      return [];
    }

    const rows = (data as { chat_id: string; od_name?: string; group_name?: string }[]) ?? [];
    return rows.map((row) => ({
      chatId: row.chat_id,
      odName: row.od_name,
      groupName: row.group_name,
    }));
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
