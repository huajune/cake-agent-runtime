import { Injectable, Logger } from '@nestjs/common';
import { UserHostingRepository } from '../repositories/user-hosting.repository';

/**
 * 缓存中单个用户的暂停状态
 */
interface PausedUserCacheEntry {
  isPaused: boolean;
  pausedAt: number;
}

/**
 * 用户托管 Service
 *
 * 职责：
 * - 维护暂停用户的内存缓存（60s TTL）
 * - 编排暂停/恢复托管的缓存写入与数据库持久化
 * - 跨表联合查询：将暂停用户列表与 user_activity 资料合并
 * - 暴露缓存刷新接口供运维使用
 *
 * 数据访问由 UserHostingRepository 负责。
 */
@Injectable()
export class UserHostingService {
  private readonly logger = new Logger(UserHostingService.name);

  private readonly CACHE_TTL_MS = 60_000; // 60 秒

  private pausedUsersCache = new Map<string, PausedUserCacheEntry>();
  private cacheExpiry = 0;

  constructor(private readonly repository: UserHostingRepository) {}

  // ==================== 托管状态查询 ====================

  /**
   * 检查指定用户是否处于暂停托管状态
   *
   * 优先读取内存缓存；缓存过期时自动从数据库刷新。
   */
  async isUserPaused(userId: string): Promise<boolean> {
    if (Date.now() > this.cacheExpiry) {
      await this.loadPausedUsers();
    }

    const entry = this.pausedUsersCache.get(userId);
    return entry !== undefined && entry.isPaused;
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
    const now = Date.now();

    this.pausedUsersCache.set(userId, { isPaused: true, pausedAt: now });

    try {
      await this.repository.upsertPause(userId, new Date(now).toISOString());
      this.logger.log(`[托管暂停] 用户 ${userId} 已暂停托管`);
    } catch (error) {
      this.logger.error(`暂停用户 ${userId} 托管失败`, error);
    }
  }

  /**
   * 恢复用户托管
   *
   * 从内存缓存中移除，并异步更新数据库。
   * 数据库写入失败不影响缓存状态。
   */
  async resumeUser(userId: string): Promise<void> {
    this.pausedUsersCache.delete(userId);

    try {
      await this.repository.updateResume(userId);
      this.logger.log(`[托管恢复] 用户 ${userId} 已恢复托管`);
    } catch (error) {
      this.logger.error(`恢复用户 ${userId} 托管失败`, error);
    }
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
    { userId: string; pausedAt: number; odName?: string; groupName?: string }[]
  > {
    if (Date.now() > this.cacheExpiry) {
      await this.loadPausedUsers();
    }

    const pausedEntries = Array.from(this.pausedUsersCache.entries())
      .filter(([, entry]) => entry.isPaused)
      .map(([userId, entry]) => ({ userId, pausedAt: entry.pausedAt }));

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
        odName: profileMap.get(entry.userId)?.odName,
        groupName: profileMap.get(entry.userId)?.groupName,
      }));
    } catch (error) {
      this.logger.error('查询暂停用户资料异常', error);
      return pausedEntries;
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
   * 加载成功后缓存有效期为 60s；失败时延长 30s 后重试，保留现有缓存数据。
   */
  private async loadPausedUsers(): Promise<void> {
    try {
      const rows = await this.repository.findPausedUserIds();

      this.pausedUsersCache.clear();
      for (const row of rows) {
        this.pausedUsersCache.set(row.user_id, {
          isPaused: true,
          pausedAt: new Date(row.paused_at).getTime(),
        });
      }

      this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;
      this.logger.debug(`已加载 ${this.pausedUsersCache.size} 个暂停托管的用户`);
    } catch (error) {
      this.logger.error('加载暂停用户列表失败', error);
      this.cacheExpiry = Date.now() + 30_000;
    }
  }
}
