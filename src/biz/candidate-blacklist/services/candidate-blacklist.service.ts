import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { CandidateBlacklistRepository } from '../repositories/candidate-blacklist.repository';
import {
  AddCandidateBlacklistParams,
  CandidateBlacklistHit,
  CandidateBlacklistRecord,
} from '../entities/candidate-blacklist.entity';

/**
 * 候选人黑名单 Service
 *
 * 运营拉黑候选人微信后，任一托管账号再次收到该候选人消息时，
 * 消息过滤层会命中黑名单 → 飞书告警（附拉黑理由）+ 永久取消该会话托管。
 *
 * 数据持久化在独立表 candidate_blacklist（含操作人/拉黑快照/命中回溯字段）。
 * 命中判定走读路径缓存（每条入站消息都会查询）：
 * - L1：本地内存 Map（1 秒热缓存）
 * - L2：Redis 共享快照
 * - L3：Supabase candidate_blacklist 表
 * 管理列表（getCandidateBlacklist）直接读 DB，保证命中回溯字段实时。
 */
@Injectable()
export class CandidateBlacklistService {
  private readonly logger = new Logger(CandidateBlacklistService.name);

  private static readonly SHARED_CACHE_KEY = 'hosting:blacklist:candidates:v2';

  private readonly CACHE_TTL_MS = 1_000; // 1 second local hot cache

  // L1: Memory cache (target_id -> record)
  private readonly memoryCache = new Map<string, CandidateBlacklistRecord>();
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
  ): Promise<CandidateBlacklistRecord | null> {
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
   * 获取完整黑名单列表（直接读 DB，保证命中回溯字段实时），并顺手回填缓存
   */
  async getCandidateBlacklist(): Promise<CandidateBlacklistRecord[]> {
    const items = await this.candidateBlacklistRepository.findAll();
    this.populateMemoryCache(items);
    await this.persistSharedCache();
    return items;
  }

  // ==================== 黑名单写操作 ====================

  /**
   * 拉黑候选人（记录操作人与会话快照），写库后刷新缓存
   *
   * 入参缺昵称/托管账号快照时（运营在 Dashboard 通常只填 ID），
   * 先从 chat_messages 反查该候选人最近的会话补全展示信息。
   */
  async addCandidateToBlacklist(params: AddCandidateBlacklistParams): Promise<void> {
    const enriched = await this.enrichContactSnapshot(params);
    await this.candidateBlacklistRepository.upsertItem(enriched);
    await this.refreshCache();

    this.logger.log(
      `[候选人黑名单] 已拉黑 ${params.targetId} (理由: ${params.reason}` +
        `${params.operator ? `, 操作人: ${params.operator}` : ''})`,
    );
  }

  /**
   * 从黑名单移除候选人，写库后刷新缓存
   *
   * 注意：命中黑名单时对会话施加的永久暂停不会随之解除，
   * 需运营在暂停托管列表中手动恢复。
   *
   * @returns 如果候选人原本在黑名单中则返回 true，否则返回 false
   */
  async removeCandidateFromBlacklist(targetId: string): Promise<boolean> {
    const deleted = await this.candidateBlacklistRepository.deleteByTargetId(targetId);
    await this.refreshCache();

    if (deleted > 0) {
      this.logger.log(`[候选人黑名单] 已移除 ${targetId}`);
      return true;
    }
    return false;
  }

  /**
   * 记录一次命中（哪个托管号在哪个会话聊到了该候选人），供回溯
   *
   * 仅更新 DB，命中字段不参与命中判定，缓存延迟可接受。
   */
  async recordHit(targetId: string, hit: CandidateBlacklistHit): Promise<void> {
    await this.candidateBlacklistRepository.recordHit(targetId, hit);
  }

  // ==================== 缓存管理 ====================

  /**
   * 强制刷新缓存（失效内存缓存并从 DB 重新加载）
   */
  async refreshCache(): Promise<void> {
    this.memoryCacheExpiry = 0;
    await this.loadCandidateBlacklist();
  }

  /**
   * 从数据库加载黑名单到内存缓存
   */
  async loadCandidateBlacklist(): Promise<void> {
    try {
      const items = await this.candidateBlacklistRepository.findAll();
      this.populateMemoryCache(items);
      await this.persistSharedCache();
      this.logger.debug(`已加载 ${this.memoryCache.size} 个黑名单候选人`);
    } catch (error) {
      this.logger.error('加载候选人黑名单失败', error);
      // Back off for 30 seconds before the next retry attempt
      this.memoryCacheExpiry = Date.now() + 30_000;
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 用 chat_messages 里的会话快照补全拉黑入参中缺失的展示字段（已有值不覆盖）。
   * 反查失败或查不到时按原始入参拉黑，不阻塞拉黑动作本身。
   */
  private async enrichContactSnapshot(
    params: AddCandidateBlacklistParams,
  ): Promise<AddCandidateBlacklistParams> {
    if (params.contactName && params.imBotId) {
      return params;
    }

    try {
      const snapshot = await this.candidateBlacklistRepository.findContactSnapshot(params.targetId);
      if (!snapshot) {
        return params;
      }

      return {
        ...params,
        chatId: params.chatId ?? snapshot.chatId,
        imContactId: params.imContactId ?? snapshot.imContactId,
        contactName: params.contactName ?? snapshot.contactName,
        imBotId: params.imBotId ?? snapshot.imBotId,
        botName: params.botName ?? snapshot.botName,
      };
    } catch (error) {
      this.logger.warn(`拉黑快照补全失败，按原始入参拉黑 targetId=${params.targetId}`, error);
      return params;
    }
  }

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

  private populateMemoryCache(items: CandidateBlacklistRecord[]): void {
    this.memoryCache.clear();
    for (const item of items) {
      this.memoryCache.set(item.target_id, item);
    }
    this.memoryCacheExpiry = Date.now() + this.CACHE_TTL_MS;
  }

  private async readSharedCache(): Promise<CandidateBlacklistRecord[] | null> {
    try {
      const cached = await this.redisService.get<{ items: CandidateBlacklistRecord[] }>(
        CandidateBlacklistService.SHARED_CACHE_KEY,
      );
      if (!cached) {
        return null;
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
