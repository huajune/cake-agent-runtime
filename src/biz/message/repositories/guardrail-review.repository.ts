import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type {
  GuardrailRepairMode,
  GuardrailRiskLevel,
  OutputDecision,
} from '@shared-types/guardrail.contract';
import type { GuardrailReviewDbRecord } from '../entities/guardrail-review.entity';
import type {
  GuardrailReviewInsertInput,
  GuardrailReviewRecord,
  GuardrailReviewWriteOutcome,
} from '../types/guardrail-review.types';

/**
 * 出站守卫审查档案 Repository。
 *
 * 稀疏附属表：仅守卫命中回合写入，与 message_processing_records 按 trace_id 1:0..1 关联。
 * 存首版全文/违规证据全文/重写版全文——紧凑摘要（guardrail_output 列）刻意不带的部分，
 * 供 Dashboard 详情页还原「首版 → 首审意见 → 重写版 → 二审」全过程。
 */
@Injectable()
export class GuardrailReviewRepository extends BaseRepository {
  protected readonly tableName = 'guardrail_review_records';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 写入一条审查档案（按 trace_id 幂等）。
   *
   * 该表是 message_processing_records 的 1:0..1 稀疏附属表；写入口必须保留
   * inserted / duplicate / failed 三态，调用方才能把重复消费和真实落库失败区分开。
   */
  async insertReviewRecord(
    input: GuardrailReviewInsertInput,
  ): Promise<GuardrailReviewWriteOutcome> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} 写入`);
      return 'failed';
    }
    if (this.circuitBlocked('UPSERT')) {
      return 'failed';
    }

    try {
      const { data, error } = await this.getClient()
        .from(this.tableName)
        .upsert(this.toDbRecord(input) as unknown as Record<string, unknown>, {
          onConflict: 'trace_id',
          ignoreDuplicates: true,
        })
        .select('trace_id');

      if (error) {
        this.handleError('UPSERT', error);
        return 'failed';
      }

      const rows = (data as Array<Pick<GuardrailReviewDbRecord, 'trace_id'>> | null) ?? [];
      return rows.length > 0 ? 'inserted' : 'duplicate';
    } catch (error) {
      this.handleError('UPSERT', error);
      return 'failed';
    }
  }

  /** 按 trace_id（= message_id）取审查档案；未命中守卫的回合返回 null。 */
  async findByTraceId(traceId: string): Promise<GuardrailReviewRecord | null> {
    const row = await this.selectOne<GuardrailReviewDbRecord>('*', (q) =>
      q.eq('trace_id', traceId).order('created_at', { ascending: false }),
    );
    return row ? this.fromDbRecord(row) : null;
  }

  /**
   * 清理过期守卫审查档案。
   *
   * guardrail_review_records 是 message_processing_records 的 trace 附属证据，
   * 保留期应跟处理流水一致，避免主账本删除后留下孤儿全文证据。
   */
  async cleanupExpiredReviews(retentionDays: number): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const result = await this.rpc<Array<{ deleted_count: string }>>(
        'cleanup_guardrail_review_records',
        { days_to_keep: retentionDays },
      );
      return parseInt(result?.[0]?.deleted_count ?? '0', 10);
    } catch (error) {
      this.logger.error(`[守卫审查档案] 清理失败:`, error);
      throw error;
    }
  }

  private toDbRecord(input: GuardrailReviewInsertInput): Partial<GuardrailReviewDbRecord> {
    return {
      trace_id: input.traceId,
      chat_id: input.chatId ?? null,
      user_id: input.userId ?? null,
      bot_im_id: input.botImId ?? null,
      bot_user_name: input.botUserName ?? null,
      contact_name: input.contactName ?? null,
      user_message: input.userMessage ?? null,
      first_reply: input.firstReply,
      first_decision: input.first.decision,
      first_risk_level: input.first.riskLevel,
      first_rule_ids: input.first.ruleIds,
      first_blocked_rule_ids: input.first.blockedRuleIds,
      first_violations: input.first.violations,
      first_feedback: input.first.feedback ?? null,
      repair_mode: input.repairMode ?? null,
      repaired: input.repaired,
      revised_reply: input.revisedReply ?? null,
      revised_decision: input.revised?.decision ?? null,
      revised_risk_level: input.revised?.riskLevel ?? null,
      revised_rule_ids: input.revised?.ruleIds ?? null,
      revised_blocked_rule_ids: input.revised?.blockedRuleIds ?? null,
      revised_violations: input.revised?.violations ?? null,
      committed_side_effects: input.committedSideEffects ?? null,
      final_decision: input.finalDecision,
      reason_code: input.reasonCode ?? null,
    };
  }

  private fromDbRecord(row: GuardrailReviewDbRecord): GuardrailReviewRecord {
    return {
      traceId: row.trace_id,
      chatId: row.chat_id ?? undefined,
      userId: row.user_id ?? undefined,
      botImId: row.bot_im_id ?? undefined,
      botUserName: row.bot_user_name ?? undefined,
      contactName: row.contact_name ?? undefined,
      userMessage: row.user_message ?? undefined,
      firstReply: row.first_reply,
      first: {
        decision: row.first_decision as OutputDecision,
        riskLevel: (row.first_risk_level ?? 'low') as GuardrailRiskLevel,
        ruleIds: row.first_rule_ids ?? [],
        blockedRuleIds: row.first_blocked_rule_ids ?? [],
        violations: row.first_violations ?? [],
        feedback: row.first_feedback ?? undefined,
      },
      repairMode: (row.repair_mode as GuardrailRepairMode) ?? undefined,
      repaired: row.repaired,
      revisedReply: row.revised_reply ?? undefined,
      revised: row.revised_decision
        ? {
            decision: row.revised_decision as OutputDecision,
            riskLevel: (row.revised_risk_level ?? 'low') as GuardrailRiskLevel,
            ruleIds: row.revised_rule_ids ?? [],
            blockedRuleIds: row.revised_blocked_rule_ids ?? [],
            violations: row.revised_violations ?? [],
          }
        : undefined,
      committedSideEffects: row.committed_side_effects ?? undefined,
      finalDecision: row.final_decision as OutputDecision,
      reasonCode: row.reason_code ?? undefined,
      createdAt: row.created_at,
    };
  }
}
