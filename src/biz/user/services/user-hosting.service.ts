import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RedisService } from '@infra/redis/redis.service';
import { UserHostingRepository } from '../repositories/user-hosting.repository';
import { UserActivityAggregate } from '../types/user.types';

/**
 * 缓存中单个用户的暂停状态
 */
interface PausedUserCacheEntry {
  isPaused: boolean;
  pausedAt: number;
  expiresAt: number;
}

/**
 * 暂停托管的自动解禁期限：3 天（硬编码）
 */
const PAUSE_DURATION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 用户托管 Service
 *
 * 职责：
 * - 维护暂停用户的本地热缓存（1 秒 TTL）与 Redis 共享快照
 * - 编排暂停/恢复托管的缓存写入与数据库持久化
 * - 跨表联合查询：将暂停用户列表与 user_activity 资料合并
 * - 暴露缓存刷新接口供运维使用
 *
 * 数据访问由 UserHostingRepository 负责。
 */
@Injectable()
export class UserHostingService {
  private readonly logger = new Logger(UserHostingService.name);

  private static readonly SHARED_CACHE_KEY = 'hosting:paused-users:v1';

  private readonly CACHE_TTL_MS = 1_000; // 1 秒本地热缓存

  private pausedUsersCache = new Map<string, PausedUserCacheEntry>();
  private cacheExpiry = 0;

  constructor(
    private readonly repository: UserHostingRepository,
    private readonly redisService: RedisService,
  ) {}

  // ==================== 托管状态查询 ====================

  /**
   * 检查指定用户是否处于暂停托管状态
   *
   * 优先读取本地热缓存；过期后优先回源 Redis，共享缓存未命中再读数据库。
   */
  async isUserPaused(userId: string): Promise<boolean> {
    await this.ensureFreshPausedUsers();

    const entry = this.pausedUsersCache.get(userId);
    if (entry === undefined || !entry.isPaused) {
      return false;
    }
    // 解禁期限到期后视为未暂停（数据库由 expirePausedUsers 异步回写）
    return entry.expiresAt > Date.now();
  }

  /**
   * 获取指定用户的托管状态摘要
   */
  async getUserHostingStatus(userId: string): Promise<{ userId: string; isPaused: boolean }> {
    const isPaused = await this.isUserPaused(userId);
    return { userId, isPaused };
  }

  // ==================== 暂停 / 恢复 ====================

  /**
   * 暂停用户托管
   *
   * 同步写入内存缓存，异步持久化到数据库。
   * 数据库写入失败不影响缓存，调用方仍可继续运行。
   */
  async pauseUser(userId: string): Promise<void> {
    await this.ensureFreshPausedUsers();

    const now = Date.now();
    const expiresAt = now + PAUSE_DURATION_MS;

    this.pausedUsersCache.set(userId, { isPaused: true, pausedAt: now, expiresAt });
    this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;

    try {
      await this.repository.upsertPause(
        userId,
        new Date(now).toISOString(),
        new Date(expiresAt).toISOString(),
      );
      this.logger.log(
        `[托管暂停] 用户 ${userId} 已暂停托管，自动解禁时间 ${new Date(expiresAt).toISOString()}`,
      );
    } catch (error) {
      this.logger.error(`暂停用户 ${userId} 托管失败`, error);
    }

    await this.persistSharedCache();
  }

  /**
   * 恢复用户托管
   *
   * 从内存缓存中移除，并异步更新数据库。
   * 数据库写入失败不影响缓存状态。
   */
  async resumeUser(userId: string): Promise<void> {
    await this.ensureFreshPausedUsers();

    this.pausedUsersCache.delete(userId);
    this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;

    try {
      await this.repository.updateResume(userId);
      this.logger.log(`[托管恢复] 用户 ${userId} 已恢复托管`);
    } catch (error) {
      this.logger.error(`恢复用户 ${userId} 托管失败`, error);
    }

    await this.persistSharedCache();
  }

  // ==================== 暂停用户列表 ====================

  /**
   * 获取所有暂停托管的用户列表，附带 user_activity 中的用户资料
   *
   * 流程：
   * 1. 确保缓存有效（过期则从 DB 刷新）
   * 2. 从缓存中提取暂停用户的 ID 与暂停时间
   * 3. 从 user_activity 批量查询 odName / groupName
   * 4. 合并返回
   *
   * 若 user_activity 查询失败，仅返回不含资料的基础列表。
   */
  async getPausedUsersWithProfiles(): Promise<
    {
      userId: string;
      pausedAt: number;
      pauseExpiresAt: number;
      odName?: string;
      groupName?: string;
    }[]
  > {
    await this.ensureFreshPausedUsers();

    const now = Date.now();
    const pausedEntries = Array.from(this.pausedUsersCache.entries())
      .filter(([, entry]) => entry.isPaused && entry.expiresAt > now)
      .map(([userId, entry]) => ({
        userId,
        pausedAt: entry.pausedAt,
        pauseExpiresAt: entry.expiresAt,
      }));

    if (pausedEntries.length === 0) {
      return [];
    }

    const userIds = pausedEntries.map((e) => e.userId);

    try {
      const profiles = await this.repository.findUserProfiles(userIds);

      const profileMap = new Map<string, { odName?: string; groupName?: string }>();
      for (const record of profiles) {
        if (!profileMap.has(record.chatId)) {
          profileMap.set(record.chatId, {
            odName: record.odName,
            groupName: record.groupName,
          });
        }
      }

      return pausedEntries.map((entry) => ({
        userId: entry.userId,
        pausedAt: entry.pausedAt,
        pauseExpiresAt: entry.pauseExpiresAt,
        odName: profileMap.get(entry.userId)?.odName,
        groupName: profileMap.get(entry.userId)?.groupName,
      }));
    } catch (error) {
      this.logger.error('查询暂停用户资料异常', error);
      return pausedEntries;
    }
  }

  // ==================== 活跃记录读写 ====================

  /**
   * 按日期范围查询活跃用户（从 user_activity 聚合）
   *
   * 供 monitoring 今日托管 / 指定日期托管面板使用。
   */
  async getActiveUsersByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<UserActivityAggregate[]> {
    return this.repository.findActiveUsersByDateRange(startDate, endDate);
  }

  /**
   * 更新用户活跃记录（供监控追踪服务使用）
   */
  async upsertActivity(data: {
    chatId: string;
    odId?: string;
    odName?: string;
    groupId?: string;
    groupName?: string;
    messageCount?: number;
    totalTokens?: number;
    activeAt?: Date;
  }): Promise<void> {
    return this.repository.upsertUserActivity(data);
  }

  /**
   * 清理过期的用户活跃记录（供数据清理服务使用）
   */
  async cleanupActivity(retentionDays: number): Promise<number> {
    return this.repository.cleanupUserActivity(retentionDays);
  }

  // ==================== 定时清理 ====================

  /**
   * 每分钟扫描一次，将已过解禁期限的暂停记录回写为恢复状态
   *
   * 与 loadPausedUsers 中的 lazy clean 互为兜底：
   * - lazy clean 依赖读流量触发；空载场景下 DB 不会被清理
   * - 本 cron 独立于流量，保证 DB 状态与 expires_at 始终一致
   *
   * UPDATE 语句幂等，多副本并发执行无副作用。
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async expireOverduePausedUsers(): Promise<void> {
    try {
      const expired = await this.repository.expirePausedUsers();
      if (expired.length === 0) {
        return;
      }
      this.logger.log(
        `[托管解禁·定时] 自动解禁 ${expired.length} 个到期用户: ${expired.join(',')}`,
      );
      // 触发缓存重载，让本地/Redis 共享缓存与 DB 同步
      await this.refreshCache();
    } catch (error) {
      this.logger.error('定时清理过期暂停记录失败', error);
    }
  }

  // ==================== 缓存管理 ====================

  /**
   * 强制刷新暂停用户缓存
   *
   * 将过期时间归零后触发 loadPausedUsers，确保下次查询读取最新数据。
   */
  async refreshCache(): Promise<void> {
    this.cacheExpiry = 0;
    await this.loadPausedUsers();
    this.logger.log('用户托管状态缓存已刷新');
  }

  // ==================== 私有方法 ====================

  /**
   * 从数据库加载所有暂停用户并填充内存缓存
   *
   * 加载成功后本地热缓存有效期为 1 秒；失败时延长 30 秒后重试，保留现有缓存数据。
   */
  private async loadPausedUsers(): Promise<void> {
    try {
      // lazy clean：先把已过解禁期限的记录回写为恢复状态
      try {
        const expired = await this.repository.expirePausedUsers();
        if (expired.length > 0) {
          this.logger.log(`[托管解禁] 自动解禁 ${expired.length} 个到期用户: ${expired.join(',')}`);
        }
      } catch (error) {
        this.logger.warn('清理过期暂停记录失败', error);
      }

      const rows = await this.repository.findPausedUserIds();

      this.pausedUsersCache.clear();
      for (const row of rows) {
        const pausedAt = new Date(row.paused_at).getTime();
        const expiresAt = row.pause_expires_at
          ? new Date(row.pause_expires_at).getTime()
          : pausedAt + PAUSE_DURATION_MS;
        this.pausedUsersCache.set(row.user_id, {
          isPaused: true,
          pausedAt,
          expiresAt,
        });
      }

      this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;
      await this.persistSharedCache();
      this.logger.debug(`已加载 ${this.pausedUsersCache.size} 个暂停托管的用户`);
    } catch (error) {
      this.logger.error('加载暂停用户列表失败', error);
      this.cacheExpiry = Date.now() + 30_000;
    }
  }

  private async ensureFreshPausedUsers(): Promise<void> {
    if (Date.now() <= this.cacheExpiry) {
      return;
    }

    const sharedEntries = await this.readSharedCache();
    if (sharedEntries) {
      this.populatePausedUsersCache(sharedEntries);
      return;
    }

    await this.loadPausedUsers();
  }

  private populatePausedUsersCache(
    entries: Array<{ userId: string; pausedAt: number; expiresAt?: number }>,
  ): void {
    this.pausedUsersCache.clear();
    for (const entry of entries) {
      this.pausedUsersCache.set(entry.userId, {
        isPaused: true,
        pausedAt: entry.pausedAt,
        // 兼容旧版 Redis 快照（无 expiresAt）：以 pausedAt + 3 天兜底
        expiresAt: entry.expiresAt ?? entry.pausedAt + PAUSE_DURATION_MS,
      });
    }
    this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;
  }

  private async readSharedCache(): Promise<Array<{
    userId: string;
    pausedAt: number;
    expiresAt?: number;
  }> | null> {
    try {
      const cached = await this.redisService.get<
        | Array<{ userId: string; pausedAt: number; expiresAt?: number }>
        | { users: Array<{ userId: string; pausedAt: number; expiresAt?: number }> }
      >(UserHostingService.SHARED_CACHE_KEY);
      if (!cached) {
        return null;
      }

      if (Array.isArray(cached)) {
        return cached;
      }

      return Array.isArray(cached.users) ? cached.users : null;
    } catch (error) {
      this.logger.warn('读取 Redis 暂停托管缓存失败', error);
      return null;
    }
  }

  private async persistSharedCache(): Promise<void> {
    try {
      const now = Date.now();
      await this.redisService.set(UserHostingService.SHARED_CACHE_KEY, {
        users: Array.from(this.pausedUsersCache.entries())
          .filter(([, entry]) => entry.isPaused && entry.expiresAt > now)
          .map(([userId, entry]) => ({
            userId,
            pausedAt: entry.pausedAt,
            expiresAt: entry.expiresAt,
          })),
        updatedAt: now,
      });
    } catch (error) {
      this.logger.warn('写入 Redis 暂停托管缓存失败', error);
    }
  }
}
