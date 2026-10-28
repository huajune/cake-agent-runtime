import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { GroupBlacklistRepository } from '../repositories/group-blacklist.repository';
import { GroupBlacklistItem } from '../entities/group-blacklist.entity';

/**
 * 小组黑名单 Service
 *
 * 负责黑名单的业务逻辑与共享缓存管理：
 * - L1：本地内存 Map（1 秒热缓存）
 * - L2：Redis 共享快照
 * - L3：Supabase system_config 表（持久化）
 *
 * 黑名单小组不触发 AI 回复，但会继续记录聊天历史。
 */
@Injectable()
export class GroupBlacklistService {
  private readonly logger = new Logger(GroupBlacklistService.name);

  private static readonly SHARED_CACHE_KEY = 'hosting:blacklist:groups:v1';

  private readonly CACHE_TTL_MS = 1_000; // 1 second local hot cache

  // L1: Memory cache
  private readonly memoryCache = new Map<string, GroupBlacklistItem>();
  private memoryCacheExpiry = 0;

  constructor(
    private readonly groupBlacklistRepository: GroupBlacklistRepository,
    private readonly redisService: RedisService,
  ) {}

  // ==================== 黑名单查询 ====================

  /**
   * 检查小组是否在黑名单中（带内存缓存）
   */
  async isGroupBlacklisted(groupId: string): Promise<boolean> {
    if (!groupId) return false;

    await this.ensureFreshCache();

    return this.memoryCache.has(groupId);
  }

  /**
   * 获取完整黑名单列表（带内存缓存）
   */
  async getGroupBlacklist(): Promise<GroupBlacklistItem[]> {
    await this.ensureFreshCache();

    return Array.from(this.memoryCache.values());
  }

  async isGroupBlacklistedStrict(groupId: string): Promise<boolean> {
    const items = await this.getGroupBlacklistStrict();
    return items.some((item) => item.group_id === groupId);
  }

  async getGroupBlacklistStrict(): Promise<GroupBlacklistItem[]> {
    const items = await this.groupBlacklistRepository.loadBlacklistFromDb();
    if (!items) throw new ServiceUnavailableException('暂时无法读取托管开关');
    return items;
  }

  async setGroupBlacklisted(groupId: string, blacklisted: boolean, reason?: string): Promise<void> {
    const items = await this.groupBlacklistRepository.setGroupBlacklisted(
      groupId,
      blacklisted,
      reason,
    );
    this.populateMemoryCache(items);
    await this.persistSharedCache();
    this.logger.log(`[小组托管] groupId=${groupId} enabled=${!blacklisted}`);
  }

  // ==================== 黑名单写操作 ====================

  /**
   * 添加小组到黑名单，同步更新内存和数据库
   */
  async addGroupToBlacklist(groupId: string, reason?: string): Promise<void> {
    await this.setGroupBlacklisted(groupId, true, reason);
  }

  /**
   * 从黑名单移除小组，同步更新内存和数据库
   *
   * @returns 如果小组原本在黑名单中则返回 true，否则返回 false
   */
  async removeGroupFromBlacklist(groupId: string): Promise<boolean> {
    const existed = await this.isGroupBlacklistedStrict(groupId);
    await this.setGroupBlacklisted(groupId, false);
    return existed;
  }

  // ==================== 缓存管理 ====================

  /**
   * 强制刷新缓存（失效内存缓存并从 DB 重新加载）
   */
  async refreshCache(): Promise<void> {
    this.memoryCacheExpiry = 0;
    await this.loadGroupBlacklist();
    this.logger.log('小组黑名单缓存已刷新');
  }

  /**
   * 从数据库加载黑名单到内存缓存
   */
  async loadGroupBlacklist(): Promise<void> {
    try {
      const items = await this.groupBlacklistRepository.loadBlacklistFromDb();
      if (!items) {
        // 读不到不覆盖内存快照、也不写回共享缓存，避免把"查询失败"传播成"没有黑名单"。
        this.markRefreshFailed('数据库暂不可读');
        return;
      }
      this.populateMemoryCache(items);
      await this.persistSharedCache();
      this.logger.log(`已加载 ${this.memoryCache.size} 个黑名单小组`);
    } catch (error) {
      this.markRefreshFailed(error);
    }
  }

  // ==================== 私有方法 ====================

  private isCacheExpired(): boolean {
    return Date.now() > this.memoryCacheExpiry;
  }

  private async ensureFreshCache(): Promise<void> {
    if (!this.isCacheExpired()) {
      return;
    }

    const sharedItems = await this.readSharedCache();
    if (sharedItems) {
      this.populateMemoryCache(sharedItems);
      return;
    }

    await this.loadGroupBlacklist();
  }

  private populateMemoryCache(items: GroupBlacklistItem[]): void {
    this.memoryCache.clear();
    for (const item of items) {
      this.memoryCache.set(item.group_id, item);
    }
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
  }

  /** 刷新失败：保留旧快照供入站过滤沿用（不把“读不到”当成“没有黑名单”），30 秒后再试。 */
  private markRefreshFailed(reason: unknown): void {
    this.logger.error('加载小组黑名单失败', reason);
    this.memoryCacheExpiry = Date.now() + 30_000;
  }

  private async readSharedCache(): Promise<GroupBlacklistItem[] | null> {
    try {
      const cached = await this.redisService.get<
        GroupBlacklistItem[] | { items: GroupBlacklistItem[] }
      >(GroupBlacklistService.SHARED_CACHE_KEY);
      if (!cached) {
        return null;
      }

      if (Array.isArray(cached)) {
        return cached;
      }

      return Array.isArray(cached.items) ? cached.items : null;
    } catch (error) {
      this.logger.warn('读取 Redis 小组黑名单缓存失败', error);
      return null;
    }
  }

  private async persistSharedCache(): Promise<void> {
    try {
      // 并发写入/读取的旧快照最多保留两秒，不能无限期覆盖较新的数据库状态。
      await this.redisService.setex(GroupBlacklistService.SHARED_CACHE_KEY, 2, {
        items: Array.from(this.memoryCache.values()),
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.logger.warn('写入 Redis 小组黑名单缓存失败', error);
    }
  }
}
