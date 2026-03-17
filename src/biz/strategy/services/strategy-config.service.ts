import { Injectable, Logger } from '@nestjs/common';
import { StrategyConfigRepository } from '../repositories/strategy-config.repository';
import { StrategyConfigRecord } from '../entities/strategy-config.entity';
import { StrategyPersona, StrategyStageGoals, StrategyRedLines } from '../types/strategy.types';
import { buildDefaultStrategyRecord } from '@shared-types/strategy-config.types';

/**
 * 策略配置 Service
 *
 * 负责 strategy_config 表的业务逻辑与内存缓存管理：
 * - L1：内存（60s TTL）
 * - L2：Supabase DB（持久化，通过 Repository 访问）
 *
 * 首次查询时若库中无记录，自动插入默认种子数据。
 */
@Injectable()
export class StrategyConfigService {
  private readonly logger = new Logger(StrategyConfigService.name);

  private readonly MEMORY_CACHE_TTL_MS = 60_000; // 60 秒

  // L1: 内存缓存
  private cachedConfig: StrategyConfigRecord | null = null;
  private cacheExpiry = 0;

  constructor(private readonly strategyConfigRepository: StrategyConfigRepository) {}

  // ==================== 读取 ====================

  /**
   * 获取当前激活的策略配置
   * 缓存优先级：内存 → DB → 自动 seed → 降级默认值
   */
  async getActiveConfig(): Promise<StrategyConfigRecord> {
    // L1: 内存缓存
    if (this.cachedConfig && Date.now() < this.cacheExpiry) {
      return this.cachedConfig;
    }

    return this.loadFromDb();
  }

  // ==================== 更新 ====================

  /**
   * 更新人格配置并刷新缓存
   */
  async updatePersona(persona: StrategyPersona): Promise<StrategyConfigRecord> {
    if (!persona.textDimensions || !Array.isArray(persona.textDimensions)) {
      throw new Error('人格配置必须包含 textDimensions 数组');
    }
    const config = await this.getActiveConfig();
    const updated = await this.strategyConfigRepository.updateConfigField(config.id, { persona });

    if (updated) {
      this.writeCache(updated);
      this.logger.log('人格配置已更新');
      return updated;
    }

    this.logger.warn('人格配置更新未匹配到记录，返回当前缓存');
    return config;
  }

  /**
   * 更新阶段目标并刷新缓存
   */
  async updateStageGoals(stageGoals: StrategyStageGoals): Promise<StrategyConfigRecord> {
    if (!stageGoals.stages || !Array.isArray(stageGoals.stages)) {
      throw new Error('阶段目标配置必须包含 stages 数组');
    }
    const config = await this.getActiveConfig();
    const updated = await this.strategyConfigRepository.updateConfigField(config.id, {
      stage_goals: stageGoals,
    });

    if (updated) {
      this.writeCache(updated);
      this.logger.log('阶段目标配置已更新');
      return updated;
    }

    this.logger.warn('阶段目标配置更新未匹配到记录，返回当前缓存');
    return config;
  }

  /**
   * 更新红线规则并刷新缓存
   */
  async updateRedLines(redLines: StrategyRedLines): Promise<StrategyConfigRecord> {
    if (!redLines.rules || !Array.isArray(redLines.rules)) {
      throw new Error('红线规则必须包含 rules 数组');
    }
    const config = await this.getActiveConfig();
    const updated = await this.strategyConfigRepository.updateConfigField(config.id, {
      red_lines: redLines,
    });

    if (updated) {
      this.writeCache(updated);
      this.logger.log('红线规则已更新');
      return updated;
    }

    this.logger.warn('红线规则更新未匹配到记录，返回当前缓存');
    return config;
  }

  // ==================== 缓存管理 ====================

  /**
   * 清除内存缓存，下次访问时重新从 DB 加载
   */
  async refreshCache(): Promise<void> {
    this.cachedConfig = null;
    this.cacheExpiry = 0;
    this.logger.log('策略配置缓存已清除');
  }

  // ==================== 私有方法 ====================

  /**
   * 从 DB 加载，无记录时自动插入默认种子数据
   */
  private async loadFromDb(): Promise<StrategyConfigRecord> {
    try {
      const record = await this.strategyConfigRepository.findActiveConfig();

      if (record) {
        this.writeCache(record);
        this.logger.log('策略配置已从数据库加载');
        return record;
      }

      // 首次运行：seed 默认数据
      return this.seedDefaults();
    } catch (error) {
      this.logger.error('加载策略配置失败，使用降级默认值', error);
      return this.buildFallbackRecord();
    }
  }

  /**
   * 首次运行时插入默认种子数据
   * 并发冲突时回退到重新查询，仍查不到时返回降级内存值
   */
  private async seedDefaults(): Promise<StrategyConfigRecord> {
    this.logger.log('首次运行，插入默认策略配置');

    const defaults = buildDefaultStrategyRecord();
    const inserted = await this.strategyConfigRepository.insertConfig(defaults);

    if (inserted) {
      this.writeCache(inserted);
      this.logger.log('默认策略配置已插入数据库');
      return inserted;
    }

    // 插入失败（并发冲突），重新查询
    const existing = await this.strategyConfigRepository.findActiveConfig();
    if (existing) {
      this.writeCache(existing);
      return existing;
    }

    return this.buildFallbackRecord();
  }

  /**
   * 写入 L1 内存缓存
   */
  private writeCache(config: StrategyConfigRecord): void {
    this.cachedConfig = config;
    this.cacheExpiry = Date.now() + this.MEMORY_CACHE_TTL_MS;
  }

  /**
   * 构建纯内存降级配置（Supabase 不可用时使用）
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
}
