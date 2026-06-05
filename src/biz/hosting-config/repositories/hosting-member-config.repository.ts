import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  HOSTING_MEMBER_CONFIG_KEY,
  HostingMemberConfig,
} from '../types/hosting-member-config.types';

/**
 * 读取 system_config 表中 hosting_member_config 这一项（纯数据访问）。
 * 自带极简读取，不依赖 SystemConfigService，避免跨模块循环依赖。
 */
@Injectable()
export class HostingMemberConfigRepository extends BaseRepository {
  protected readonly tableName = 'system_config';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  async readConfig(): Promise<HostingMemberConfig | null> {
    if (!this.isAvailable()) return null;
    const row = await this.selectOne<{ value: unknown }>('value', (q) =>
      q.eq('key', HOSTING_MEMBER_CONFIG_KEY),
    );
    const value = row?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as HostingMemberConfig;
  }
}
