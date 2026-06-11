import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { CandidateBlacklistRepository } from '../repositories/candidate-blacklist.repository';
import { CandidateBlacklistItem } from '../entities/candidate-blacklist.entity';

/**
 * 候选人黑名单 Service
 *
 * 运营拉黑候选人微信后，任一托管账号再次收到该候选人消息时，
 * 消息过滤层会命中黑名单 → 飞书告警（附拉黑理由）+ 永久取消该会话托管。
 *
 * 缓存结构与小组黑名单一致：
 * - L1：本地内存 Map（1 秒热缓存）
 * - L2：Redis 共享快照
 * - L3：Supabase system_config 表（持久化）
 */
@Injectable()
export class CandidateBlacklistService {
  private readonly logger = new Logger(CandidateBlacklistService.name);

  private static readonly SHARED_CACHE_KEY = 'hosting:blacklist:candidates:v1';

  private readonly CACHE_TTL_MS = 1_000; // 1 second local hot cache

  // L1: Memory cache
  private readonly memoryCache = new Map<string, CandidateBlacklistItem>();
  private memoryCacheExpiry = 0;

  constructor(
    private readonly candidateBlacklistRepository: CandidateBlacklistRepository,
    private readonly redisService: RedisService,
  ) {}

  // ==================== 黑名单查询 ====================

  /**
   * 任一 ID 命中黑名单即返回命中项。
   *
   * 同一候选人在不同上下文里存在多个等价 ID（chatId / imContactId / externalUserId），
   * 运营拉黑时使用其中任意一个均可命中。
   */
  async matchBlacklisted(
    targetIds: ReadonlyArray<string | null | undefined>,
  ): Promise<CandidateBlacklistItem | null> {
    await this.ensureFreshCache();

    for (const id of targetIds) {
      if (!id) continue;
      const item = this.memoryCache.get(id);
      if (item) {
        return item;
      }
    }
    return null;
  }

  /**
   * 获取完整黑名单列表（带内存缓存）
   */
  async getCandidateBlacklist(): Promise<CandidateBlacklistItem[]> {
    await this.ensureFreshCache();

    return Array.from(this.memoryCache.values());
  }

  // ==================== 黑名单写操作 ====================

  /**
   * 拉黑候选人，同步更新内存和数据库
   */
  async addCandidateToBlacklist(
    targetId: string,
    reason: string,
    operator?: string,
  ): Promise<void> {
    await this.ensureFreshCache();

    const item: CandidateBlacklistItem = {
      target_id: targetId,
      reason,
      operator,
      added_at: Date.now(),
    };

    this.memoryCache.set(targetId, item);
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
    await this.persistCache();
    await this.persistSharedCache();

    this.logger.log(
      `[候选人黑名单] 已拉黑 ${targetId} (理由: ${reason}${operator ? `, 操作人: ${operator}` : ''})`,
    );
  }

  /**
   * 从黑名单移除候选人，同步更新内存和数据库
   *
   * 注意：命中黑名单时对会话施加的永久暂停不会随之解除，
   * 需运营在暂停托管列表中手动恢复。
   *
   * @returns 如果候选人原本在黑名单中则返回 true，否则返回 false
   */
  async removeCandidateFromBlacklist(targetId: string): Promise<boolean> {
    await this.ensureFreshCache();

    if (!this.memoryCache.has(targetId)) {
      return false;
    }

    this.memoryCache.delete(targetId);
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
    await this.persistCache();
    await this.persistSharedCache();

    this.logger.log(`[候选人黑名单] 已移除 ${targetId}`);
    return true;
  }

  // ==================== 缓存管理 ====================

  /**
   * 强制刷新缓存（失效内存缓存并从 DB 重新加载）
   */
  async refreshCache(): Promise<void> {
    this.memoryCacheExpiry = 0;
    await this.loadCandidateBlacklist();
    this.logger.log('候选人黑名单缓存已刷新');
  }

  /**
   * 从数据库加载黑名单到内存缓存
   */
  async loadCandidateBlacklist(): Promise<void> {
    try {
      const items = await this.candidateBlacklistRepository.loadBlacklistFromDb();
      this.populateMemoryCache(items);
      await this.persistSharedCache();
      this.logger.log(`已加载 ${this.memoryCache.size} 个黑名单候选人`);
    } catch (error) {
      this.logger.error('加载候选人黑名单失败', error);
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

    await this.loadCandidateBlacklist();
  }

  private populateMemoryCache(items: CandidateBlacklistItem[]): void {
    this.memoryCache.clear();
    for (const item of items) {
      this.memoryCache.set(item.target_id, item);
    }
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
  }

  /**
   * 将当前内存缓存持久化到数据库
   */
  private async persistCache(): Promise<void> {
    const blacklistArray = Array.from(this.memoryCache.values());

    try {
      await this.candidateBlacklistRepository.saveBlacklistToDb(blacklistArray);
    } catch (error) {
      this.logger.error('保存候选人黑名单到数据库失败', error);
    }
  }

  private async readSharedCache(): Promise<CandidateBlacklistItem[] | null> {
    try {
      const cached = await this.redisService.get<
        CandidateBlacklistItem[] | { items: CandidateBlacklistItem[] }
      >(CandidateBlacklistService.SHARED_CACHE_KEY);
      if (!cached) {
        return null;
      }

      if (Array.isArray(cached)) {
        return cached;
      }

      return Array.isArray(cached.items) ? cached.items : null;
    } catch (error) {
      this.logger.warn('读取 Redis 候选人黑名单缓存失败', error);
      return null;
    }
  }

  private async persistSharedCache(): Promise<void> {
    try {
      await this.redisService.set(CandidateBlacklistService.SHARED_CACHE_KEY, {
        items: Array.from(this.memoryCache.values()),
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.logger.warn('写入 Redis 候选人黑名单缓存失败', error);
    }
  }
}
