import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RecruitmentCaseRecord } from '../entities/recruitment-case.entity';
import type {
  RecruitmentCaseSnapshot,
  RecruitmentCaseStatus,
  RecruitmentCaseType,
} from '../types/recruitment-case.types';

@Injectable()
export class RecruitmentCaseRepository extends BaseRepository {
  protected readonly tableName = 'recruitment_cases';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  async findLatestByChatAndType(params: {
    corpId: string;
    chatId: string;
    caseType: RecruitmentCaseType;
    statuses?: RecruitmentCaseStatus[];
  }): Promise<RecruitmentCaseRecord | null> {
    return this.selectOne<RecruitmentCaseRecord>('*', (q) => {
      let query = q
        .eq('corp_id', params.corpId)
        .eq('chat_id', params.chatId)
        .eq('case_type', params.caseType)
        .order('updated_at', { ascending: false });

      if (params.statuses?.length) {
        query = query.in('status', params.statuses);
      }

      return query;
    });
  }

  async findLatestHandoffByTarget(targetId: string): Promise<RecruitmentCaseRecord | null> {
    const [chatCase, userCase] = await Promise.all([
      this.findLatestHandoffByColumn('chat_id', targetId),
      this.findLatestHandoffByColumn('user_id', targetId),
    ]);

    if (!chatCase) return userCase;
    if (!userCase) return chatCase;

    return this.getMostRecentlyUpdated(chatCase, userCase);
  }

  async closeOpenCases(params: {
    corpId: string;
    chatId: string;
    caseType: RecruitmentCaseType;
  }): Promise<void> {
    await this.update<RecruitmentCaseRecord>(
      {
        status: 'closed',
      },
      (q) =>
        q
          .eq('corp_id', params.corpId)
          .eq('chat_id', params.chatId)
          .eq('case_type', params.caseType)
          .in('status', ['active', 'handoff']),
    );
  }

  async createCase(params: {
    corpId: string;
    chatId: string;
    userId?: string | null;
    caseType: RecruitmentCaseType;
    status: RecruitmentCaseStatus;
    snapshot: RecruitmentCaseSnapshot;
    lastRelevantAt?: string | null;
  }): Promise<RecruitmentCaseRecord | null> {
    return this.insert<RecruitmentCaseRecord>({
      corp_id: params.corpId,
      chat_id: params.chatId,
      user_id: params.userId ?? null,
      case_type: params.caseType,
      status: params.status,
      booking_id: params.snapshot.bookingId ?? null,
      booked_at: params.snapshot.bookedAt ?? null,
      interview_time: params.snapshot.interviewTime ?? null,
      job_id: params.snapshot.jobId ?? null,
      job_name: params.snapshot.jobName ?? null,
      brand_name: params.snapshot.brandName ?? null,
      store_name: params.snapshot.storeName ?? null,
      bot_im_id: params.snapshot.botImId ?? null,
      followup_window_ends_at: params.snapshot.followupWindowEndsAt ?? null,
      last_relevant_at: params.lastRelevantAt ?? null,
      metadata: params.snapshot.metadata ?? {},
    });
  }

  async updateStatus(
    id: string,
    status: RecruitmentCaseStatus,
    extra?: Partial<RecruitmentCaseRecord>,
  ): Promise<RecruitmentCaseRecord | null> {
    const rows = await this.update<RecruitmentCaseRecord>(
      {
        status,
        ...extra,
      },
      (q) => q.eq('id', id),
    );

    return rows[0] ?? null;
  }

  private async findLatestHandoffByColumn(
    column: 'chat_id' | 'user_id',
    targetId: string,
  ): Promise<RecruitmentCaseRecord | null> {
    return this.selectOne<RecruitmentCaseRecord>('*', (q) =>
      q
        .eq('case_type', 'onboard_followup')
        .eq('status', 'handoff')
        .eq(column, targetId)
        .order('updated_at', { ascending: false }),
    );
  }

  private getMostRecentlyUpdated(
    left: RecruitmentCaseRecord,
    right: RecruitmentCaseRecord,
  ): RecruitmentCaseRecord {
    const leftUpdatedAt = Date.parse(left.updated_at);
    const rightUpdatedAt = Date.parse(right.updated_at);

    if (Number.isNaN(leftUpdatedAt)) return right;
    if (Number.isNaN(rightUpdatedAt)) return left;

    return leftUpdatedAt >= rightUpdatedAt ? left : right;
  }
}
