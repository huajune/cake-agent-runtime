import type { GuardrailDecision } from '@/api/types/chat.types';

export const DECISION_LABELS: Record<GuardrailDecision, string> = {
  pass: '放行',
  observe: '观察',
  revise: '要求重写',
  replan: '要求重查',
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
