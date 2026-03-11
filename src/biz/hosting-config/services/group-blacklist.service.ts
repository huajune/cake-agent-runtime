import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@core/redis';
import { GroupBlacklistRepository } from '../repositories/group-blacklist.repository';
import { GroupBlacklistItem } from '../entities/group-blacklist.entity';

/**
 * 小组黑名单 Service
 *
 * 负责黑名单的业务逻辑与三级缓存管理：
 * - L1：内存 Map（5分钟 TTL）
 * - L2：Redis（5分钟 TTL）
 * - L3：Supabase system_config 表（持久化）
 *
 * 黑名单小组不触发 AI 回复，但会继续记录聊天历史。
 */
@Injectable()
export class GroupBlacklistService {
  private readonly logger = new Logger(GroupBlacklistService.name);

  // Cache configuration
  private readonly CACHE_TTL_MS = 300_000; // 5 minutes
  private readonly CACHE_TTL_SECONDS = 300; // 5 minutes (for Redis)
  private readonly CACHE_KEY = 'supabase:config:group_blacklist';

  // L1: Memory cache
  private readonly memoryCache = new Map<string, GroupBlacklistItem>();
  private memoryCacheExpiry = 0;

  constructor(
    private readonly groupBlacklistRepository: GroupBlacklistRepository,
    private readonly redisService: RedisService,
  ) {}

  // ==================== 黑名单查询 ====================

  /**
   * 检查小组是否在黑名单中（带三级缓存）
   */
  async isGroupBlacklisted(groupId: string): Promise<boolean> {
    if (!groupId) return false;

    if (this.isCacheExpired()) {
      await this.loadGroupBlacklist();
    }

    return this.memoryCache.has(groupId);
  }

  /**
   * 获取完整黑名单列表（带三级缓存）
   */
  async getGroupBlacklist(): Promise<GroupBlacklistItem[]> {
    if (this.isCacheExpired()) {
      await this.loadGroupBlacklist();
    }

    return Array.from(this.memoryCache.values());
  }

  // ==================== 黑名单写操作 ====================

  /**
   * 添加小组到黑名单，同步更新所有缓存层
   */
  async addGroupToBlacklist(groupId: string, reason?: string): Promise<void> {
    const item: GroupBlacklistItem = {
      group_id: groupId,
      reason,
      added_at: Date.now(),
    };

    this.memoryCache.set(groupId, item);
    await this.persistCache();

    this.logger.log(`[小组黑名单] 已添加小组 ${groupId}${reason ? ` (原因: ${reason})` : ''}`);
  }

  /**
   * 从黑名单移除小组，同步更新所有缓存层
   *
   * @returns 如果小组原本在黑名单中则返回 true，否则返回 false
   */
  async removeGroupFromBlacklist(groupId: string): Promise<boolean> {
    if (!this.memoryCache.has(groupId)) {
      return false;
    }

    this.memoryCache.delete(groupId);
    await this.persistCache();

    this.logger.log(`[小组黑名单] 已移除小组 ${groupId}`);
    return true;
  }

  // ==================== 缓存管理 ====================

  /**
   * 强制刷新缓存（失效内存缓存并从 Redis/DB 重新加载）
   */
  async refreshCache(): Promise<void> {
    this.memoryCacheExpiry = 0;
    await this.loadGroupBlacklist();
    this.logger.log('小组黑名单缓存已刷新');
  }

  /**
   * 从 Redis（L2）或数据库（L3）加载黑名单到内存缓存（L1）
   */
  async loadGroupBlacklist(): Promise<void> {
    // L2: Try Redis first
    const cached = await this.redisService.get<GroupBlacklistItem[]>(this.CACHE_KEY);

    if (cached && Array.isArray(cached)) {
      this.populateMemoryCache(cached);
      this.logger.debug(`已从 Redis 加载 ${this.memoryCache.size} 个黑名单小组`);
      return;
    }

    // L3: Fall back to database
    try {
      const items = await this.groupBlacklistRepository.loadBlacklistFromDb();
      this.populateMemoryCache(items);

      // Backfill Redis from DB result
      const blacklistArray = Array.from(this.memoryCache.values());
      await this.redisService.setex(this.CACHE_KEY, this.CACHE_TTL_SECONDS, blacklistArray);

      this.logger.log(`已加载 ${this.memoryCache.size} 个黑名单小组`);
    } catch (error) {
      this.logger.error('加载小组黑名单失败', error);
      // Back off for 30 seconds before the next retry attempt
      this.memoryCacheExpiry = Date.now() + 30_000;
      return;
    }

    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
  }

  // ==================== 私有方法 ====================

  private isCacheExpired(): boolean {
    return Date.now() > this.memoryCacheExpiry;
  }

  private populateMemoryCache(items: GroupBlacklistItem[]): void {
    this.memoryCache.clear();
    for (const item of items) {
      this.memoryCache.set(item.group_id, item);
    }
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
  }

  /**
   * 将当前内存缓存持久化到 Redis 和数据库
   */
  private async persistCache(): Promise<void> {
    const blacklistArray = Array.from(this.memoryCache.values());

    await this.redisService.setex(this.CACHE_KEY, this.CACHE_TTL_SECONDS, blacklistArray);

    try {
      await this.groupBlacklistRepository.saveBlacklistToDb(blacklistArray);
    } catch (error) {
      this.logger.error('保存小组黑名单到数据库失败', error);
    }
  }
}
