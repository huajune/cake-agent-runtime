import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  AddCandidateBlacklistParams,
  CandidateBlacklistHit,
  CandidateBlacklistRecord,
  CandidateContactSnapshot,
} from '../entities/candidate-blacklist.entity';

/** 按 im_contact_id / external_user_id 反查时的时间下界（这两列无索引，限定扫描范围） */
const SNAPSHOT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** 候选人标识的合法字符（chatId / imContactId / externalUserId 均为该形态） */
const SAFE_TARGET_ID_PATTERN = /^[\w@\-.:]+$/;

interface ChatMessageSnapshotRow {
  chat_id: string | null;
  im_contact_id: string | null;
  candidate_name: string | null;
  manager_name: string | null;
  im_bot_id: string | null;
  is_self: boolean | null;
}

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
        im_bot_id: params.imBotId ?? null,
        bot_name: params.botName ?? null,
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
        p_contact_name: hit.contactName ?? null,
      });
    } catch (error) {
      this.logger.error(`记录候选人黑名单命中失败 targetId=${targetId}`, error);
    }
  }

  /**
   * 从 chat_messages 反查候选人会话快照（昵称 / 会话 / 托管账号），拉黑时补全展示信息。
   *
   * targetId 可能是 chatId / imContactId / externalUserId 任一：
   * - 先按 chat_id 等值查（有索引，运营从用户列表复制的多为会话 ID）；
   * - 未命中再按 im_contact_id / external_user_id 匹配，这两列无索引，
   *   用最近 30 天的时间下界兜住扫描范围。
   * 取最近若干条消息按字段聚合，避免最新一条恰好缺昵称/托管号字段。
   * 机器人侧消息行（is_self=true）的 im_contact_id 是机器人自己的 ID，
   * 候选人 ID 只能取自候选人发的行。
   */
  async findContactSnapshot(targetId: string): Promise<CandidateContactSnapshot | null> {
    const columns = 'chat_id,im_contact_id,candidate_name,manager_name,im_bot_id,is_self';

    let rows = await this.selectFrom<ChatMessageSnapshotRow>('chat_messages', columns, (q) =>
      q.eq('chat_id', targetId).order('timestamp', { ascending: false }).limit(10),
    );

    // or() 过滤串不走参数化，targetId 形态异常时跳过兜底查询防注入
    if (rows.length === 0 && SAFE_TARGET_ID_PATTERN.test(targetId)) {
      const sinceIso = new Date(Date.now() - SNAPSHOT_LOOKBACK_MS).toISOString();
      rows = await this.selectFrom<ChatMessageSnapshotRow>('chat_messages', columns, (q) =>
        q
          .or(`im_contact_id.eq.${targetId},external_user_id.eq.${targetId}`)
          .gte('timestamp', sinceIso)
          .order('timestamp', { ascending: false })
          .limit(10),
      );
    }

    if (rows.length === 0) {
      return null;
    }

    const pick = (
      source: ChatMessageSnapshotRow[],
      key: keyof Omit<ChatMessageSnapshotRow, 'is_self'>,
    ): string | undefined =>
      source.map((row) => row[key]).find((value): value is string => Boolean(value));

    const candidateRows = rows.filter((row) => row.is_self === false);

    return {
      chatId: pick(rows, 'chat_id'),
      imContactId: pick(candidateRows, 'im_contact_id'),
      contactName: pick(rows, 'candidate_name'),
      imBotId: pick(rows, 'im_bot_id'),
      botName: pick(rows, 'manager_name'),
    };
  }
}
