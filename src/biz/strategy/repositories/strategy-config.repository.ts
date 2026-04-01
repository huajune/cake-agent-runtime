import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { StrategyConfigRecord, StrategyConfigStatus } from '../entities/strategy-config.entity';

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
   * 按 status 查询激活的策略配置
   * SELECT * FROM strategy_config WHERE status = $status AND is_active = true LIMIT 1
   */
  async findByStatus(status: StrategyConfigStatus): Promise<StrategyConfigRecord | null> {
    return this.selectOne<StrategyConfigRecord>('*', (q) =>
      q.eq('status', status).eq('is_active', true),
    );
  }

  /**
   * 查询当前激活的策略配置记录（兼容旧调用，默认读 released）
   */
  async findActiveConfig(): Promise<StrategyConfigRecord | null> {
    return this.findByStatus('released');
  }

  /**
   * 查询最大版本号
   */
  async findMaxVersion(): Promise<number> {
    const result = await this.selectOne<{ version: number }>('version', (q) =>
      q.order('version', { ascending: false }),
    );
    return result?.version ?? 0;
  }

  /**
   * 插入新的策略配置记录
   */
  async insertConfig(data: Record<string, unknown>): Promise<StrategyConfigRecord | null> {
    return this.insert<StrategyConfigRecord>(data);
  }

  /**
   * 按 id 更新策略配置的指定字段
   */
  async updateConfigField(
    id: string,
    data: Partial<StrategyConfigRecord>,
  ): Promise<StrategyConfigRecord | null> {
    const results = await this.update<StrategyConfigRecord>(data, (q) => q.eq('id', id));
    return results.length > 0 ? results[0] : null;
  }

  /**
   * 查询版本列表（released + archived，按版本号倒序）
   */
  async findVersionHistory(limit = 20): Promise<StrategyConfigRecord[]> {
    return this.select<StrategyConfigRecord>(
      'id, name, status, version, version_note, released_at, created_at, updated_at',
      (q) =>
        q
          .in('status', ['released', 'archived'])
          .order('version', { ascending: false })
          .limit(limit),
    );
  }

  /**
   * 原子化发布策略（RPC，数据库事务）
   */
  async publishStrategy(versionNote?: string): Promise<{
    released_id: string;
    archived_id: string;
    new_testing_id: string;
    version: number;
  }> {
    return this.rpc('publish_strategy', { p_version_note: versionNote ?? null });
  }
}
