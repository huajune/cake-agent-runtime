import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  AddCandidateBlacklistParams,
  CandidateBlacklistHit,
  CandidateBlacklistRecord,
} from '../entities/candidate-blacklist.entity';

/**
 * 候选人黑名单 Repository
 *
 * 纯数据访问层，负责 candidate_blacklist 表的 CRUD 与命中回溯 RPC。
 * 缓存策略（内存 + Redis）由 CandidateBlacklistService 管理。
 */
@Injectable()
export class CandidateBlacklistRepository extends BaseRepository {
  protected readonly tableName = 'candidate_blacklist';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 拉取全量黑名单（按拉黑时间倒序）
   */
  async findAll(): Promise<CandidateBlacklistRecord[]> {
    if (!this.isAvailable()) {
      return [];
    }

    return this.select<CandidateBlacklistRecord>('*', (q) =>
      q.order('created_at', { ascending: false }),
    );
  }

  /**
   * UPSERT 黑名单记录（按 target_id 冲突时更新理由/操作人/快照）
   */
  async upsertItem(params: AddCandidateBlacklistParams): Promise<void> {
    await this.upsert(
      {
        target_id: params.targetId,
        reason: params.reason,
        operator: params.operator ?? null,
        chat_id: params.chatId ?? null,
        im_contact_id: params.imContactId ?? null,
        contact_name: params.contactName ?? null,
        source: params.source ?? 'manual',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'target_id', returnData: false },
    );
  }

  /**
   * 删除黑名单记录
   *
   * @returns 删除的行数（0 表示原本不在黑名单中）
   */
  async deleteByTargetId(targetId: string): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    const { data, error } = await this.getClient()
      .from(this.tableName)
      .delete()
      .eq('target_id', targetId)
      .select('target_id');

    if (error) {
      this.handleError('DELETE', error);
      return 0;
    }

    return ((data as { target_id: string }[]) ?? []).length;
  }

  /**
   * 记录一次命中（hit_count 原子自增 + 最近命中快照），通过 RPC 避免读-改-写竞态
   */
  async recordHit(targetId: string, hit: CandidateBlacklistHit): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.rpc('record_candidate_blacklist_hit', {
        p_target_id: targetId,
        p_chat_id: hit.chatId ?? null,
        p_bot_id: hit.botId ?? null,
        p_message_id: hit.messageId ?? null,
      });
    } catch (error) {
      this.logger.error(`记录候选人黑名单命中失败 targetId=${targetId}`, error);
    }
  }
}
