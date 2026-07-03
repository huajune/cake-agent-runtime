import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  GuardrailRepairMode,
  GuardrailRiskLevel,
  GuardViolation,
  OutputDecision,
} from '@shared-types/guardrail.contract';

/** 出站守卫单次审查的全文详情（首审必有；二审仅 repaired 时存在）。 */
export interface GuardrailReviewStepDetail {
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  ruleIds: string[];
  blockedRuleIds: string[];
  /** 违规意见全文（type/evidence/suggestion/severity…），紧凑摘要里被裁掉的部分。 */
  violations: GuardViolation[];
  /** feedbackToGenerator 聚合文本，即注入重写 prompt 的违规反馈。 */
  feedback?: string;
}

/** 一条出站守卫审查档案（写入/读取共用形状，camelCase）。 */
export interface GuardrailReviewRecord {
  traceId: string;
  chatId?: string;
  userId?: string;
  botImId?: string;
  botUserName?: string;
  contactName?: string;
  userMessage?: string;
  /** 首版回复全文（触发 revise/replan 时被丢弃重写的那一版）。 */
  firstReply: string;
  first: GuardrailReviewStepDetail;
  repairMode?: GuardrailRepairMode;
  repaired: boolean;
  /** 受控修复后的重写版全文；repaired=false 时为 undefined。 */
  revisedReply?: string;
  revised?: GuardrailReviewStepDetail;
  /** 重写时注入的既成副作用提示。 */
  committedSideEffects?: string;
  finalDecision: OutputDecision;
  reasonCode?: string;
  createdAt?: string;
}

/** guardrail_review_records 行（snake_case）。 */
interface GuardrailReviewDbRecord {
  created_at: string;
  trace_id: string;
  chat_id: string | null;
  user_id: string | null;
  bot_im_id: string | null;
  bot_user_name: string | null;
  contact_name: string | null;
  user_message: string | null;
  first_reply: string;
  first_decision: string;
  first_risk_level: string | null;
  first_rule_ids: string[] | null;
  first_blocked_rule_ids: string[] | null;
  first_violations: GuardViolation[] | null;
  first_feedback: string | null;
  repair_mode: string | null;
  repaired: boolean;
  revised_reply: string | null;
  revised_decision: string | null;
  revised_risk_level: string | null;
  revised_rule_ids: string[] | null;
  revised_blocked_rule_ids: string[] | null;
  revised_violations: GuardViolation[] | null;
  committed_side_effects: string | null;
  final_decision: string;
  reason_code: string | null;
}

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

  /** 写入一条审查档案（fire-and-forget 场景使用；失败仅记日志，不抛出）。 */
  async record(input: GuardrailReviewRecord): Promise<void> {
    await this.insert<GuardrailReviewDbRecord>(this.toDbRecord(input), { returnData: false });
  }

  /** 按 trace_id（= message_id）取审查档案；未命中守卫的回合返回 null。 */
  async findByTraceId(traceId: string): Promise<GuardrailReviewRecord | null> {
    const row = await this.selectOne<GuardrailReviewDbRecord>('*', (q) =>
      q.eq('trace_id', traceId).order('created_at', { ascending: false }),
    );
    return row ? this.fromDbRecord(row) : null;
  }

  private toDbRecord(input: GuardrailReviewRecord): Partial<GuardrailReviewDbRecord> {
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
