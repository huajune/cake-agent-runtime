import { Injectable, Logger } from '@nestjs/common';
import { GroupBlacklistRepository } from '../repositories/group-blacklist.repository';
import { GroupBlacklistItem } from '../entities/group-blacklist.entity';

/**
 * 小组黑名单 Service
 *
 * 负责黑名单的业务逻辑与两级缓存管理：
 * - L1：内存 Map（5分钟 TTL）
 * - L2：Supabase system_config 表（持久化）
 *
 * 黑名单小组不触发 AI 回复，但会继续记录聊天历史。
 */
@Injectable()
export class GroupBlacklistService {
  private readonly logger = new Logger(GroupBlacklistService.name);

  private readonly CACHE_TTL_MS = 300_000; // 5 minutes

  // L1: Memory cache
  private readonly memoryCache = new Map<string, GroupBlacklistItem>();
  private memoryCacheExpiry = 0;

  constructor(private readonly groupBlacklistRepository: GroupBlacklistRepository) {}

  // ==================== 黑名单查询 ====================

  /**
   * 检查小组是否在黑名单中（带内存缓存）
   */
  async isGroupBlacklisted(groupId: string): Promise<boolean> {
    if (!groupId) return false;

    if (this.isCacheExpired()) {
      await this.loadGroupBlacklist();
    }

    return this.memoryCache.has(groupId);
  }

  /**
   * 获取完整黑名单列表（带内存缓存）
   */
  async getGroupBlacklist(): Promise<GroupBlacklistItem[]> {
    if (this.isCacheExpired()) {
      await this.loadGroupBlacklist();
    }

    return Array.from(this.memoryCache.values());
  }

  // ==================== 黑名单写操作 ====================

  /**
   * 添加小组到黑名单，同步更新内存和数据库
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
   * 从黑名单移除小组，同步更新内存和数据库
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
}
