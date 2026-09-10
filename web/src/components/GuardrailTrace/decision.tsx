import type { GuardrailDecision } from '@/api/types/chat.types';

/**
 * `replan`：2026-09-09 起为同参数重生成档。`guardrail_review_records` 里 2026-07-27 之前
 * 约 459 条同名老行属于已删除的旧实现（带反馈 + 只读工具重写），按 created_at 区分。
 */
export const DECISION_LABELS: Record<GuardrailDecision, string> = {
  pass: '审查通过',
  observe: '观察',
  repair: '要求修复',
  revise: '要求重写（历史）',
  replan: '要求重生成',
  block: '审查未通过（历史）',
};

const DECISION_TONES: Record<GuardrailDecision, 'success' | 'warning' | 'danger' | 'info'> = {
  pass: 'success',
  observe: 'info',
  repair: 'warning',
  revise: 'warning',
  replan: 'warning',
  block: 'danger',
};

export function decisionBadge(decision: GuardrailDecision) {
  return (
    <span className={`status-badge ${DECISION_TONES[decision]}`}>{DECISION_LABELS[decision]}</span>
  );
}
