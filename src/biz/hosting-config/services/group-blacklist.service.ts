import { Injectable, Logger } from '@nestjs/common';
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

  // ==================== 黑名单写操作 ====================

  /**
   * 添加小组到黑名单，同步更新内存和数据库
   */
  async addGroupToBlacklist(groupId: string, reason?: string): Promise<void> {
    await this.ensureFreshCache();

    const item: GroupBlacklistItem = {
      group_id: groupId,
      reason,
      added_at: Date.now(),
    };

    this.memoryCache.set(groupId, item);
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
    await this.persistCache();
    await this.persistSharedCache();

    this.logger.log(`[小组黑名单] 已添加小组 ${groupId}${reason ? ` (原因: ${reason})` : ''}`);
  }

  /**
   * 从黑名单移除小组，同步更新内存和数据库
   *
   * @returns 如果小组原本在黑名单中则返回 true，否则返回 false
   */
  async removeGroupFromBlacklist(groupId: string): Promise<boolean> {
    await this.ensureFreshCache();

    if (!this.memoryCache.has(groupId)) {
      return false;
    }

    this.memoryCache.delete(groupId);
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
    await this.persistCache();
    await this.persistSharedCache();

    this.logger.log(`[小组黑名单] 已移除小组 ${groupId}`);
    return true;
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
      this.populateMemoryCache(items);
      await this.persistSharedCache();
      this.logger.log(`已加载 ${this.memoryCache.size} 个黑名单小组`);
    } catch (error) {
      this.logger.error('加载小组黑名单失败', error);
      // Back off for 30 seconds before the next retry attempt
      this.memoryCacheExpiry = Date.now() + 30_000;
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

  /**
   * 将当前内存缓存持久化到数据库
   */
  private async persistCache(): Promise<void> {
    const blacklistArray = Array.from(this.memoryCache.values());

    try {
      await this.groupBlacklistRepository.saveBlacklistToDb(blacklistArray);
    } catch (error) {
      this.logger.error('保存小组黑名单到数据库失败', error);
    }
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
      await this.redisService.set(GroupBlacklistService.SHARED_CACHE_KEY, {
        items: Array.from(this.memoryCache.values()),
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.logger.warn('写入 Redis 小组黑名单缓存失败', error);
    }
  }
}
