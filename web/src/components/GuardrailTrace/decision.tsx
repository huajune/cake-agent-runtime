import type { GuardrailDecision } from '@/api/types/chat.types';

/**
 * `replan` 是**历史档案专用**档位：2026-07-27 退役、2026-08-13 从后端类型层删除，
 * 新流水不会再出现。但 `guardrail_review_records` 里仍有 459 条 2026-07-27 之前的
 * 老行（该表无定期清理），翻旧流水时必须能正常渲染，故本词表保留该键。
 */
export const DECISION_LABELS: Record<GuardrailDecision, string> = {
  pass: '放行',
  observe: '观察',
  revise: '要求重写',
  replan: '要求重查（已退役）',
  block: '拦截',
};

const DECISION_TONES: Record<GuardrailDecision, 'success' | 'warning' | 'danger' | 'info'> = {
  pass: 'success',
  observe: 'info',
  revise: 'warning',
  replan: 'warning',
  block: 'danger',
};

export function decisionBadge(decision: GuardrailDecision) {
  return <span className={`status-badge ${DECISION_TONES[decision]}`}>{DECISION_LABELS[decision]}</span>;
}
