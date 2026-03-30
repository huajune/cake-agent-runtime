import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { StrategyConfigRepository } from '../repositories/strategy-config.repository';
import { StrategyChangelogRepository } from '../repositories/strategy-changelog.repository';
import { StrategyConfigRecord, StrategyConfigStatus } from '../entities/strategy-config.entity';
import {
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
  StrategyRoleSetting,
} from '../types/strategy.types';

/**
 * 策略配置 Service
 *
 * 支持 testing / released 双版本：
 * - testing：Web 编辑 + ChatTester 使用
 * - released：企微用户使用
 * - publish()：将 testing 内容发布为 released
 *
 * 缓存：L1 内存（60s TTL），按 status 分别缓存。
 */
@Injectable()
export class StrategyConfigService {
  private readonly logger = new Logger(StrategyConfigService.name);

  private readonly MEMORY_CACHE_TTL_MS = 60_000;

  // L1: 按 status 分别缓存
  private cache = new Map<StrategyConfigStatus, { config: StrategyConfigRecord; expiry: number }>();

  constructor(
    private readonly strategyConfigRepository: StrategyConfigRepository,
    private readonly changelogRepository: StrategyChangelogRepository,
  ) {}

  // ==================== 读取 ====================

  /**
   * 获取指定状态的策略配置（默认 released）
   */
  async getActiveConfig(status: StrategyConfigStatus = 'released'): Promise<StrategyConfigRecord> {
    const cached = this.cache.get(status);
    if (cached && Date.now() < cached.expiry) {
      return cached.config;
    }
    return this.loadFromDb(status);
  }

  /**
   * 获取 testing 版本（Web 编辑 / ChatTester 用）
   */
  async getTestingConfig(): Promise<StrategyConfigRecord> {
    return this.getActiveConfig('testing');
  }

  /**
   * 获取 released 版本（企微用户用）
   */
  async getReleasedConfig(): Promise<StrategyConfigRecord> {
    return this.getActiveConfig('released');
  }

  // ==================== 更新（只改 testing）====================

  async updatePersona(persona: StrategyPersona): Promise<StrategyConfigRecord> {
    if (!persona.textDimensions || !Array.isArray(persona.textDimensions)) {
      throw new Error('人格配置必须包含 textDimensions 数组');
    }
    const config = await this.getTestingConfig();
    const updated = await this.strategyConfigRepository.updateConfigField(config.id, { persona });

    if (!updated) {
      this.logger.error(`人格配置更新失败，config.id=${config.id} 未匹配到记录`);
      throw new InternalServerErrorException('人格配置更新失败，请刷新页面后重试');
    }

    this.writeCache('testing', updated);
    this.logger.log('人格配置已更新（testing）');
    return updated;
  }

  async updateRoleSetting(roleSetting: StrategyRoleSetting): Promise<StrategyConfigRecord> {
    const config = await this.getTestingConfig();
    const updated = await this.strategyConfigRepository.updateConfigField(config.id, {
      role_setting: roleSetting,
    });

    if (!updated) {
      this.logger.error(`角色设定更新失败，config.id=${config.id} 未匹配到记录`);
      throw new InternalServerErrorException('角色设定更新失败，请刷新页面后重试');
    }

    this.writeCache('testing', updated);
    this.logger.log('角色设定已更新（testing）');
    return updated;
  }

  async updateStageGoals(stageGoals: StrategyStageGoals): Promise<StrategyConfigRecord> {
    if (!stageGoals.stages || !Array.isArray(stageGoals.stages)) {
      throw new Error('阶段目标配置必须包含 stages 数组');
    }
    const config = await this.getTestingConfig();
    const updated = await this.strategyConfigRepository.updateConfigField(config.id, {
      stage_goals: stageGoals,
    });

    if (!updated) {
      this.logger.error(`阶段目标配置更新失败，config.id=${config.id} 未匹配到记录`);
      throw new InternalServerErrorException('阶段目标配置更新失败，请刷新页面后重试');
    }

    this.writeCache('testing', updated);
    this.logger.log('阶段目标配置已更新（testing）');
    return updated;
  }

  async updateRedLines(redLines: StrategyRedLines): Promise<StrategyConfigRecord> {
    if (!redLines.rules || !Array.isArray(redLines.rules)) {
      throw new Error('红线规则必须包含 rules 数组');
    }
    const config = await this.getTestingConfig();
    const updated = await this.strategyConfigRepository.updateConfigField(config.id, {
      red_lines: redLines,
    });

    if (!updated) {
      this.logger.error(`红线规则更新失败，config.id=${config.id} 未匹配到记录`);
      throw new InternalServerErrorException('红线规则更新失败，请刷新页面后重试');
    }

    this.writeCache('testing', updated);
    this.logger.log('红线规则已更新（testing）');
    return updated;
  }

  // ==================== 发布 ====================

  /**
   * 将 testing 版本发布为 released（数据库事务，原子操作）
   *
   * 流程（在单个事务中完成）：
   * 1. 当前 released → archived
   * 2. testing → released
   * 3. 创建新的 testing 记录
   */
  async publish(versionNote?: string): Promise<StrategyConfigRecord> {
    const result = await this.strategyConfigRepository.publishStrategy(versionNote);

    this.cache.clear();

    const newReleased = await this.getReleasedConfig();
    this.logger.log(`策略已发布: v${result.version}`);
    return newReleased;
  }

  // ==================== 版本历史 ====================

  async getVersionHistory(limit = 20): Promise<StrategyConfigRecord[]> {
    return this.strategyConfigRepository.findVersionHistory(limit);
  }

  // ==================== 变更历史（兼容旧接口） ====================

  async getChangelog(limit = 20) {
    const config = await this.getReleasedConfig();
    return this.changelogRepository.findByConfigId(config.id, limit);
  }

  // ==================== 缓存管理 ====================

  async refreshCache(): Promise<void> {
    this.cache.clear();
    this.logger.log('策略配置缓存已清除');
  }

  // ==================== 私有方法 ====================

  private async loadFromDb(status: StrategyConfigStatus): Promise<StrategyConfigRecord> {
    const record = await this.strategyConfigRepository.findByStatus(status);

    if (!record) {
      throw new InternalServerErrorException(`数据库中未找到 ${status} 状态的策略配置`);
    }

    this.writeCache(status, record);
    this.logger.log(`策略配置已从数据库加载（${status}）`);
    return record;
  }

  private writeCache(status: StrategyConfigStatus, config: StrategyConfigRecord): void {
    this.cache.set(status, {
      config,
      expiry: Date.now() + this.MEMORY_CACHE_TTL_MS,
    });
  }
}
