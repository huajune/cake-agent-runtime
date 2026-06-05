import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecruitmentCaseRecord } from '../entities/recruitment-case.entity';
import { RecruitmentCaseRepository } from '../repositories/recruitment-case.repository';
import type { RecruitmentCaseSnapshot } from '../types/recruitment-case.types';

/**
 * @deprecated recruitment_cases 状态机（active/handoff/closed）已废弃（P2-3）。
 * - 预约指针迁到 agent_long_term_memories.latest_booking（{@link LongTermService.setLatestBooking}）。
 * - handoff 触发分析迁到 handoff_events + ops_events.handoff.triggered。
 * - 运行时托管状态用 UserHostingService 的 pause/resume 一层表达。
 *
 * 本服务的所有方法（openOnBookingSuccess / getActiveOnboardFollowupCase / markHandoff /
 * closeLatestHandoffCase）当前**无任何调用方**，模块仅被 6 处 import 残留（dead wiring）。
 * 计划：解除各 module 的 RecruitmentCaseModule import + onboard-followup-notification.types 的
 * RecruitmentCaseRecord 类型依赖后整体删除（不删表、不迁 262 行历史数据）。
 */
@Injectable()
export class RecruitmentCaseService {
  private readonly logger = new Logger(RecruitmentCaseService.name);

  constructor(
    private readonly repository: RecruitmentCaseRepository,
    private readonly configService: ConfigService,
  ) {}

  async openOnBookingSuccess(params: {
    corpId: string;
    chatId: string;
    userId?: string | null;
    snapshot: RecruitmentCaseSnapshot;
  }): Promise<RecruitmentCaseRecord | null> {
    const snapshot = {
      ...params.snapshot,
      bookedAt: params.snapshot.bookedAt ?? new Date().toISOString(),
      followupWindowEndsAt:
        params.snapshot.followupWindowEndsAt ??
        this.computeFollowupWindowEndsAt(params.snapshot.interviewTime),
    };

    await this.repository.closeOpenCases({
      corpId: params.corpId,
      chatId: params.chatId,
      caseType: 'onboard_followup',
    });

    const created = await this.repository.createCase({
      corpId: params.corpId,
      chatId: params.chatId,
      userId: params.userId,
      caseType: 'onboard_followup',
      status: 'active',
      snapshot,
      lastRelevantAt: new Date().toISOString(),
    });

    if (created) {
      this.logger.log(
        `[RecruitmentCase] 已创建 onboarding case: chatId=${params.chatId}, bookingId=${snapshot.bookingId ?? 'unknown'}`,
      );
    }

    return created;
  }

  async getActiveOnboardFollowupCase(params: {
    corpId: string;
    chatId: string;
  }): Promise<RecruitmentCaseRecord | null> {
    const record = await this.repository.findLatestByChatAndType({
      corpId: params.corpId,
      chatId: params.chatId,
      caseType: 'onboard_followup',
      statuses: ['active'],
    });

    if (!record) return null;
    if (this.isExpired(record)) return null;
    return record;
  }

  async markHandoff(caseId: string): Promise<RecruitmentCaseRecord | null> {
    return this.repository.updateStatus(caseId, 'handoff', {
      last_relevant_at: new Date().toISOString(),
    });
  }

  async closeLatestHandoffCase(targetId: string): Promise<RecruitmentCaseRecord | null> {
    const record = await this.repository.findLatestHandoffByTarget(targetId);
    if (!record) return null;

    const closed = await this.repository.updateStatus(record.id, 'closed');
    if (closed) {
      this.logger.log(
        `[RecruitmentCase] 已关闭 handoff case: target=${targetId}, caseId=${record.id}`,
      );
    }
    return closed;
  }

  private computeFollowupWindowEndsAt(interviewTime?: string | null): string {
    const base = this.parseInterviewTime(interviewTime) ?? new Date();
    const days = parseInt(
      this.configService.get<string>('RECRUITMENT_FOLLOWUP_WINDOW_DAYS', '7'),
      10,
    );
    const endAt = new Date(base.getTime());
    endAt.setDate(endAt.getDate() + (Number.isFinite(days) ? days : 7));
    return endAt.toISOString();
  }

  private parseInterviewTime(interviewTime?: string | null): Date | null {
    if (!interviewTime?.trim()) return null;
    const normalized = interviewTime.trim().replace(' ', 'T');
    const parsed = new Date(`${normalized}+08:00`);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private isExpired(record: RecruitmentCaseRecord): boolean {
    if (!record.followup_window_ends_at) return false;
    return new Date(record.followup_window_ends_at).getTime() < Date.now();
  }
}
