import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { SupabaseService } from '../supabase.service';

/**
 * 用户托管状态记录
 */
export interface UserHostingStatus {
  user_id: string;
  is_paused: boolean;
  paused_at: string | null;
  resumed_at: string | null;
  pause_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * 用户活跃记录
 */
export interface UserActivityRecord {
  chat_id: string;
  od_id?: string;
  od_name?: string;
  group_id?: string;
  group_name?: string;
  last_active_at: string;
  message_count: number;
  total_tokens: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * 用户托管状态 Repository
 *
 * 负责管理用户托管状态和活跃记录：
 * - user_hosting_status 表：用户暂停/恢复托管状态
 * - user_activity 表：用户活跃记录
 */
@Injectable()
export class UserHostingRepository extends BaseRepository {
  protected readonly tableName = 'user_hosting_status';

  // 缓存配置
  private readonly HOSTING_STATUS_CACHE_TTL = 60; // 1分钟

  // 内存缓存（热数据）
  private pausedUsersCache = new Map<string, { isPaused: boolean; pausedAt: number }>();
  private pausedUsersCacheExpiry = 0;

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // ==================== 用户托管状态 ====================

  /**
   * 检查用户是否被暂停托管
   * 使用内存缓存，每60秒刷新一次
   */
  async isUserPaused(userId: string): Promise<boolean> {
    // 检查缓存是否过期
    if (Date.now() > this.pausedUsersCacheExpiry) {
      await this.loadPausedUsers();
    }

    return this.pausedUsersCache.has(userId) && this.pausedUsersCache.get(userId)!.isPaused;
  }

  /**
   * 从数据库加载所有暂停的用户
   */
  async loadPausedUsers(): Promise<void> {
    if (!this.isAvailable()) {
      this.pausedUsersCacheExpiry = Date.now() + this.HOSTING_STATUS_CACHE_TTL * 1000;
      return;
    }

    try {
      const results = await this.select<{ user_id: string; paused_at: string }>({
        is_paused: 'eq.true',
        select: 'user_id,paused_at',
        order: 'paused_at.desc',
      });

      // 清空并重新填充缓存
      this.pausedUsersCache.clear();

      for (const user of results) {
        this.pausedUsersCache.set(user.user_id, {
          isPaused: true,
          pausedAt: new Date(user.paused_at).getTime(),
        });
      }

      this.pausedUsersCacheExpiry = Date.now() + this.HOSTING_STATUS_CACHE_TTL * 1000;
      this.logger.debug(`已加载 ${this.pausedUsersCache.size} 个暂停托管的用户`);
    } catch (error) {
      this.logger.error('加载暂停用户列表失败', error);
      // 保持现有缓存，延长过期时间
      this.pausedUsersCacheExpiry = Date.now() + 30000; // 30秒后重试
    }
  }

  /**
   * 暂停用户托管
   */
  async pauseUser(userId: string): Promise<void> {
    const now = Date.now();

    // 更新内存缓存
    this.pausedUsersCache.set(userId, { isPaused: true, pausedAt: now });

    // 更新数据库
    if (this.isAvailable()) {
      try {
        // 使用 upsert
        await this.insert(
          {
            user_id: userId,
            is_paused: true,
            paused_at: new Date(now).toISOString(),
            pause_count: 1,
          },
          { resolution: 'merge-duplicates' },
        );

        // 如果是更新，修改暂停状态
        await this.update(
          { user_id: `eq.${userId}` },
          {
            is_paused: true,
            paused_at: new Date(now).toISOString(),
          },
        );

        this.logger.log(`[托管暂停] 用户 ${userId} 已暂停托管`);
      } catch (error) {
        this.logger.error(`暂停用户 ${userId} 托管失败`, error);
      }
    }
  }

  /**
   * 恢复用户托管
   */
  async resumeUser(userId: string): Promise<void> {
    // 更新内存缓存
    this.pausedUsersCache.delete(userId);

    // 更新数据库
    if (this.isAvailable()) {
      try {
        await this.update(
          { user_id: `eq.${userId}` },
          {
            is_paused: false,
            resumed_at: new Date().toISOString(),
          },
        );

        this.logger.log(`[托管恢复] 用户 ${userId} 已恢复托管`);
      } catch (error) {
        this.logger.error(`恢复用户 ${userId} 托管失败`, error);
      }
    }
  }

  /**
   * 获取所有暂停托管的用户列表（附带用户资料）
   */
  async getPausedUsers(): Promise<
    { userId: string; pausedAt: number; odName?: string; groupName?: string }[]
  > {
    // 确保缓存是最新的
    if (Date.now() > this.pausedUsersCacheExpiry) {
      await this.loadPausedUsers();
    }

    const pausedUserIds = Array.from(this.pausedUsersCache.entries())
      .filter(([, status]) => status.isPaused)
      .map(([userId, status]) => ({
        userId,
        pausedAt: status.pausedAt,
      }));

    if (pausedUserIds.length === 0) {
      return [];
    }

    try {
      // 从 user_activity 表查询用户资料
      const userIdList = pausedUserIds.map((u) => u.userId).join(',');
      const profiles = await this.selectFromTable<{
        chat_id: string;
        od_name?: string;
        group_name?: string;
      }>('user_activity', {
        chat_id: `in.(${userIdList})`,
        select: 'chat_id,od_name,group_name',
        order: 'last_active_at.desc',
      });

      // 创建 userId -> profile 的映射
      const profileMap = new Map<string, { odName?: string; groupName?: string }>();
      profiles.forEach((record) => {
        if (!profileMap.has(record.chat_id)) {
          profileMap.set(record.chat_id, {
            odName: record.od_name,
            groupName: record.group_name,
          });
        }
      });

      // 合并用户资料
      return pausedUserIds.map((user) => ({
        userId: user.userId,
        pausedAt: user.pausedAt,
        odName: profileMap.get(user.userId)?.odName,
        groupName: profileMap.get(user.userId)?.groupName,
      }));
    } catch (error) {
      this.logger.error('查询暂停用户资料异常', error);
      return pausedUserIds;
    }
  }

  /**
   * 获取用户托管状态
   */
  async getUserHostingStatus(userId: string): Promise<{ userId: string; isPaused: boolean }> {
    const isPaused = await this.isUserPaused(userId);
    return { userId, isPaused };
  }

  // ==================== 用户活跃记录 ====================

  /**
   * 更新用户活跃记录（Upsert）
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
   * 清理过期的用户活跃记录
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
          `✅ 用户活跃记录清理完成: 删除 ${deletedCount} 条 ${retentionDays} 天前的记录`,
        );
      }
      return deletedCount;
    } catch (error) {
      this.logger.error('清理用户活跃记录失败', error);
      return 0;
    }
  }

  // ==================== 缓存管理 ====================

  /**
   * 刷新缓存
   */
  async refreshCache(): Promise<void> {
    this.pausedUsersCacheExpiry = 0;
    await this.loadPausedUsers();
    this.logger.log('用户托管状态缓存已刷新');
  }

  // ==================== 私有方法 ====================

  /**
   * 从其他表查询（临时方法，用于跨表查询）
   */
  private async selectFromTable<T>(table: string, params?: Record<string, string>): Promise<T[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const response = await this.getClient().get<T[]>(`/${table}`, { params });
      return response.data ?? [];
    } catch (error) {
      this.handleError(`SELECT from ${table}`, error);
      return [];
    }
  }
}
