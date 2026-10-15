import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { GroupBlacklistItem } from '../entities/group-blacklist.entity';
import { SystemConfigKey } from '@enums/hosting-config.enum';

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
   * 读不到（客户端未初始化 / 熔断 OPEN / 瞬时错误重试后仍失败）返回 null，与「确认没有黑名单」的空数组区分：
   * 调用方据此保留旧快照或 fail closed，不能把查询失败当成"没有小组被拉黑"。
   *
   * @returns 黑名单项数组；键不存在或值不是数组时返回空数组；读不到返回 null
   */
  async loadBlacklistFromDb(): Promise<GroupBlacklistItem[] | null> {
    const rows = await this.selectFromOrNull<{ value?: unknown }>(this.tableName, 'value', (q) =>
      q.eq('key', SystemConfigKey.GROUP_BLACKLIST).limit(1),
    );
    if (!rows) return null;

    const value = rows[0]?.value;
    return Array.isArray(value) ? (value as GroupBlacklistItem[]) : [];
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
      (q) => q.eq('key', SystemConfigKey.GROUP_BLACKLIST),
    );

    if (!updated || updated.length === 0) {
      await this.insert({
        key: SystemConfigKey.GROUP_BLACKLIST,
        value: items,
        description: '小组黑名单（不触发AI回复但记录历史）',
      });
    }
  }
}
