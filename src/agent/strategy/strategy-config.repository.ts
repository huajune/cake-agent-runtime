import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase/repositories/base.repository';
import { SupabaseService } from '@core/supabase/supabase.service';
import {
  StrategyConfigRecord,
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
  buildDefaultStrategyRecord,
} from './strategy-config.types';

/**
 * 策略配置 Repository
 *
 * 操作 strategy_config 表，提供三层缓存：
 * - 内存缓存（60s TTL）
 * - Redis 缓存（300s TTL）
 * - Supabase DB
 */
@Injectable()
export class StrategyConfigRepository extends BaseRepository {
  protected readonly tableName = 'strategy_config';

  private readonly MEMORY_CACHE_TTL = 60 * 1000; // 60 秒
  private readonly REDIS_CACHE_TTL = 300; // 300 秒

  // 内存缓存
  private cachedConfig: StrategyConfigRecord | null = null;
  private cacheExpiry = 0;

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // ==================== 读取 ====================

  /**
   * 获取当前激活的策略配置
   * 缓存优先级：内存 → Redis → DB → 自动 seed
   */
  async getActiveConfig(): Promise<StrategyConfigRecord> {
    // 1. 内存缓存
    if (this.cachedConfig && Date.now() < this.cacheExpiry) {
      return this.cachedConfig;
    }

    // 2. Redis 缓存
    const cacheKey = this.getRedisCacheKey();
    const redis = this.supabaseService.getRedisService();
    const cached = await redis.get<StrategyConfigRecord>(cacheKey);
    if (cached) {
      this.cachedConfig = cached;
      this.cacheExpiry = Date.now() + this.MEMORY_CACHE_TTL;
      this.logger.debug('已从 Redis 加载策略配置');
      return cached;
    }

    // 3. DB 加载
    return this.loadFromDb();
  }

  // ==================== 更新 ====================

  /**
   * 更新人格配置
   */
  async updatePersona(persona: StrategyPersona): Promise<StrategyConfigRecord> {
    const config = await this.getActiveConfig();
    return this.updateField(config.id, { persona });
  }

  /**
   * 更新阶段目标
   */
  async updateStageGoals(stageGoals: StrategyStageGoals): Promise<StrategyConfigRecord> {
    const config = await this.getActiveConfig();
    return this.updateField(config.id, { stage_goals: stageGoals });
  }

  /**
   * 更新红线规则
   */
  async updateRedLines(redLines: StrategyRedLines): Promise<StrategyConfigRecord> {
    const config = await this.getActiveConfig();
    return this.updateField(config.id, { red_lines: redLines });
  }

  // ==================== 缓存管理 ====================

  /**
   * 清除所有缓存
   */
  async refreshCache(): Promise<void> {
    this.cachedConfig = null;
    this.cacheExpiry = 0;

    const redis = this.supabaseService.getRedisService();
    await redis.del(this.getRedisCacheKey());

    this.logger.log('策略配置缓存已清除');
  }

  // ==================== 私有方法 ====================

  /**
   * 从 DB 加载，无数据时自动 seed
   */
  private async loadFromDb(): Promise<StrategyConfigRecord> {
    if (!this.isAvailable()) {
      this.logger.warn('Supabase 未初始化，使用默认策略配置');
      return this.buildFallbackRecord();
    }

    try {
      const result = await this.selectOne<StrategyConfigRecord>({
        is_active: 'eq.true',
      });

      if (result) {
        await this.updateCache(result);
        this.logger.log('策略配置已从数据库加载');
        return result;
      }

      // 首次运行：seed 默认数据
      return this.seedDefaults();
    } catch (error) {
      this.logger.error('加载策略配置失败，使用默认值', error);
      return this.buildFallbackRecord();
    }
  }

  /**
   * 首次运行时插入默认种子数据
   */
  private async seedDefaults(): Promise<StrategyConfigRecord> {
    this.logger.log('首次运行，插入默认策略配置');

    const defaults = buildDefaultStrategyRecord();
    const inserted = await this.insert<StrategyConfigRecord>(defaults);

    if (inserted) {
      await this.updateCache(inserted);
      this.logger.log('默认策略配置已插入数据库');
      return inserted;
    }

    // 插入失败（可能并发冲突），重新查询
    const existing = await this.selectOne<StrategyConfigRecord>({
      is_active: 'eq.true',
    });

    if (existing) {
      await this.updateCache(existing);
      return existing;
    }

    return this.buildFallbackRecord();
  }

  /**
   * 更新指定字段并刷新缓存
   */
  private async updateField(
    id: string,
    data: Partial<StrategyConfigRecord>,
  ): Promise<StrategyConfigRecord> {
    if (!this.isAvailable()) {
      this.logger.warn('Supabase 未初始化，跳过策略配置更新');
      return this.getActiveConfig();
    }

    try {
      const updated = await this.update<StrategyConfigRecord>({ id: `eq.${id}` }, data);

      if (updated.length > 0) {
        await this.updateCache(updated[0]);
        this.logger.log(`策略配置已更新: ${Object.keys(data).join(', ')}`);
        return updated[0];
      }

      this.logger.warn('策略配置更新未匹配到记录');
      return this.getActiveConfig();
    } catch (error) {
      this.logger.error('更新策略配置失败', error);
      throw error;
    }
  }

  /**
   * 更新内存 + Redis 缓存
   */
  private async updateCache(config: StrategyConfigRecord): Promise<void> {
    this.cachedConfig = config;
    this.cacheExpiry = Date.now() + this.MEMORY_CACHE_TTL;

    try {
      const redis = this.supabaseService.getRedisService();
      await redis.setex(this.getRedisCacheKey(), this.REDIS_CACHE_TTL, config);
    } catch (error) {
      this.logger.warn('更新 Redis 缓存失败', error);
    }
  }

  /**
   * 构建降级用的内存配置记录
   */
  private buildFallbackRecord(): StrategyConfigRecord {
    const defaults = buildDefaultStrategyRecord();
    return {
      id: 'fallback',
      ...defaults,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  private getRedisCacheKey(): string {
    return `${this.supabaseService.getCachePrefix()}strategy_config:active`;
  }
}
