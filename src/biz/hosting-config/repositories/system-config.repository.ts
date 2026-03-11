import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import { SystemConfigRecord } from '../entities';

/**
 * 系统配置 Repository
 *
 * 纯数据访问层，仅封装 system_config 表的 CRUD 操作。
 * 缓存策略、业务逻辑及配置变更通知由 SystemConfigService 负责。
 */
@Injectable()
export class SystemConfigRepository extends BaseRepository {
  protected readonly tableName = 'system_config';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 读取指定键的配置值
   *
   * @param key 配置键名
   * @returns 配置值，键不存在时返回 null
   */
  async getConfigValue<T>(key: string): Promise<T | null> {
    if (!this.isAvailable()) {
      return null;
    }

    const result = await this.selectOne<SystemConfigRecord>('value', (q) => q.eq('key', key));
    if (!result) {
      return null;
    }

    return result.value as T;
  }

  /**
   * 写入指定键的配置值（不存在时插入，已存在时更新）
   *
   * @param key 配置键名
   * @param value 配置值
   * @param description 可选描述（仅在首次插入时使用）
   */
  async setConfigValue(key: string, value: unknown, description?: string): Promise<void> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过写入配置项: ${key}`);
      return;
    }

    const updated = await this.update<SystemConfigRecord>(
      { value } as Partial<SystemConfigRecord>,
      (q) => q.eq('key', key),
    );

    if (!updated || updated.length === 0) {
      await this.insert<SystemConfigRecord>({
        key,
        value,
        description,
      });
      this.logger.log(`配置项 ${key} 已初始化到数据库`);
    }
  }
}
