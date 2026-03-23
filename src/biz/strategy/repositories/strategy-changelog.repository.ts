import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { StrategyChangelogRecord } from '../entities/strategy-changelog.entity';

/**
 * 策略配置变更日志 Repository
 *
 * 纯数据访问层，操作 strategy_config_changelog 表。
 */
@Injectable()
export class StrategyChangelogRepository extends BaseRepository {
  protected readonly tableName = 'strategy_config_changelog';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 写入变更记录
   */
  async insertLog(data: {
    config_id: string;
    field: string;
    old_value: unknown;
    new_value: unknown;
    changed_by?: string;
  }): Promise<StrategyChangelogRecord | null> {
    return this.insert<StrategyChangelogRecord>(data as Partial<StrategyChangelogRecord>);
  }

  /**
   * 按 config_id 查询变更历史（时间倒序）
   */
  async findByConfigId(configId: string, limit = 20): Promise<StrategyChangelogRecord[]> {
    return this.select<StrategyChangelogRecord>('*', (q) =>
      q.eq('config_id', configId).order('changed_at', { ascending: false }).limit(limit),
    );
  }
}
