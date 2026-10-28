import { Injectable, ServiceUnavailableException } from '@nestjs/common';
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

  /** 数据库内锁住配置行，仅变更目标小组；失败必须反馈给操作人。 */
  async setGroupBlacklisted(
    groupId: string,
    blacklisted: boolean,
    reason?: string,
  ): Promise<GroupBlacklistItem[]> {
    if (!this.isAvailable()) throw new ServiceUnavailableException('托管开关暂不可用');
    const { data, error } = await this.getClient()
      .rpc('set_hosting_group_blacklisted', {
        p_group_id: groupId,
        p_blacklisted: blacklisted,
        p_reason: reason ?? null,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error || !Array.isArray(data))
      throw new ServiceUnavailableException('托管开关保存失败，请刷新确认后重试');
    return data as GroupBlacklistItem[];
  }

  /**
   * 从数据库读取黑名单数组
   *
   * 读不到（客户端未初始化 / 熔断 OPEN / 瞬时错误重试后仍失败）返回 null，与「确认没有黑名单」的空数组区分：
   * 调用方据此保留旧快照或 fail closed，不能把查询失败当成"没有小组被拉黑"。
   *
   * @returns 黑名单项数组；键不存在时返回空数组；读不到或数据格式错误返回 null
   */
  async loadBlacklistFromDb(): Promise<GroupBlacklistItem[] | null> {
    const rows = await this.selectFromOrNull<{ value?: unknown }>(this.tableName, 'value', (q) =>
      q.eq('key', SystemConfigKey.GROUP_BLACKLIST).limit(1),
    );
    if (!rows) return null;

    if (!rows.length) return [];
    const value = rows[0]?.value;
    return Array.isArray(value) ? (value as GroupBlacklistItem[]) : null;
  }
}
