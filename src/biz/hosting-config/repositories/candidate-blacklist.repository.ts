import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { CandidateBlacklistItem } from '../entities/candidate-blacklist.entity';

/**
 * 候选人黑名单 Repository
 *
 * 纯数据访问层，负责将黑名单数组读写至 system_config 表的 candidate_blacklist 键。
 * 缓存策略（内存 + Redis）由 CandidateBlacklistService 管理。
 */
@Injectable()
export class CandidateBlacklistRepository extends BaseRepository {
  protected readonly tableName = 'system_config';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 从数据库读取黑名单数组
   *
   * @returns 黑名单项数组；数据库不可用或键不存在时返回空数组
   */
  async loadBlacklistFromDb(): Promise<CandidateBlacklistItem[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const result = await this.selectOne<{ value: CandidateBlacklistItem[] }>('value', (q) =>
      q.eq('key', 'candidate_blacklist'),
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
  async saveBlacklistToDb(items: CandidateBlacklistItem[]): Promise<void> {
    if (!this.isAvailable()) {
      this.logger.warn('Supabase 未初始化，跳过保存候选人黑名单');
      return;
    }

    const updated = await this.update<{ key: string; value: CandidateBlacklistItem[] }>(
      { value: items },
      (q) => q.eq('key', 'candidate_blacklist'),
    );

    if (!updated || updated.length === 0) {
      await this.insert({
        key: 'candidate_blacklist',
        value: items,
        description: '候选人黑名单（命中后告警并永久取消该会话托管）',
      });
    }
  }
}
