import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';

/**
 * 小组黑名单项
 */
export interface GroupBlacklistItem {
  groupId: string;
  reason?: string;
  addedAt: number;
}

/**
 * 小组黑名单 Repository
 *
 * 纯数据访问层，负责将黑名单数组读写至 system_config 表的 group_blacklist 键。
 * 缓存策略（内存 + Redis）由 GroupBlacklistService 管理。
 */
@Injectable()
export class GroupBlacklistRepository extends BaseRepository {
  protected readonly tableName = 'system_config';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 从数据库读取黑名单数组
   *
   * @returns 黑名单项数组；数据库不可用或键不存在时返回空数组
   */
  async loadBlacklistFromDb(): Promise<GroupBlacklistItem[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const result = await this.selectOne<{ value: GroupBlacklistItem[] }>('value', (q) =>
      q.eq('key', 'group_blacklist'),
    );

    if (result && Array.isArray(result.value)) {
      return result.value;
    }

    return [];
  }

  /**
   * 将黑名单数组持久化到数据库（UPDATE，若不存在则 INSERT）
   *
   * @param items 要保存的黑名单项数组
   */
  async saveBlacklistToDb(items: GroupBlacklistItem[]): Promise<void> {
    if (!this.isAvailable()) {
      this.logger.warn('Supabase 未初始化，跳过保存小组黑名单');
      return;
    }

    const updated = await this.update<{ key: string; value: GroupBlacklistItem[] }>(
      { value: items },
      (q) => q.eq('key', 'group_blacklist'),
    );

    if (!updated || updated.length === 0) {
      await this.insert({
        key: 'group_blacklist',
        value: items,
        description: '小组黑名单（不触发AI回复但记录历史）',
      });
    }
  }
}
