import type { GuardViolation } from '@shared-types/guardrail.contract';

/**
 * 出站守卫审查档案数据库格式
 * @table guardrail_review_records
 */
export interface GuardrailReviewDbRecord {
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
