import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import { StrategyConfigRecord } from '../entities';

/**
 * 策略配置 Repository
 *
 * 纯数据访问层，操作 strategy_config 表。
 * 不包含缓存、业务规则或默认值逻辑——这些由 StrategyConfigService 负责。
 */
@Injectable()
export class StrategyConfigRepository extends BaseRepository {
  protected readonly tableName = 'strategy_config';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 查询当前激活的策略配置记录
   * SELECT * FROM strategy_config WHERE is_active = true LIMIT 1
   */
  async findActiveConfig(): Promise<StrategyConfigRecord | null> {
    return this.selectOne<StrategyConfigRecord>('*', (q) => q.eq('is_active', true));
  }

  /**
   * 插入新的策略配置记录
   * INSERT INTO strategy_config (...) VALUES (...)
   */
  async insertConfig(data: Record<string, unknown>): Promise<StrategyConfigRecord | null> {
    return this.insert<StrategyConfigRecord>(data);
  }

  /**
   * 按 id 更新策略配置的指定字段
   * UPDATE strategy_config SET ... WHERE id = $id
   */
  async updateConfigField(
    id: string,
    data: Partial<StrategyConfigRecord>,
  ): Promise<StrategyConfigRecord | null> {
    const results = await this.update<StrategyConfigRecord>(data, (q) => q.eq('id', id));
    return results.length > 0 ? results[0] : null;
  }
}
