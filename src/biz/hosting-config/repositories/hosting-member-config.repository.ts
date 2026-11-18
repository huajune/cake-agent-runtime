import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { hostingMemberConfigSchema } from '../types/hosting-member-config.schema';
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
    // BaseRepository.selectOne 将数据库故障也折叠成 null；这里必须区分故障和显式删除。
    const operation = 'SELECT';
    if (!this.isAvailable() || this.circuitBlocked(operation)) {
      throw new Error('托管成员配置数据库暂不可用');
    }
    let value: unknown;
    try {
      const { data, error } = await this.getClient()
        .from(this.tableName)
        .select('value')
        .eq('key', HOSTING_MEMBER_CONFIG_KEY)
        .maybeSingle();
      if (error) throw error;
      this.recordCircuitSuccess(operation);
      if (!data) return null;
      value = data.value;
    } catch (error) {
      this.noteOutcome(operation, error);
      // 不透传可能含配置内容的 SDK 错误。
      throw new Error('读取托管成员配置失败');
    }
    const parsed = hostingMemberConfigSchema.safeParse(value);
    if (!parsed.success) throw new Error('托管成员配置格式无效');
    return parsed.data;
  }
}
