/** API 读取模型兼容旧档案；不用于执行或派发人工介入。 */
export interface GuardrailOutcomeReadModel {
  finalOutcome?: 'reply' | 'handoff' | 'skipped';
  finalDecision?: string;
  legacyFinalDecision?: 'block';
  reasonCode?: string;
}

export function guardrailOutcomeDisplay(value: GuardrailOutcomeReadModel, advisory = false) {
  if (advisory) return { kind: 'advisory', label: '仅审查建议', tone: 'info' } as const;
  const legacy = value.finalDecision ?? value.legacyFinalDecision;
  const outcome =
    value.finalOutcome ??
    (legacy === 'pass' || legacy === 'observe'
      ? 'reply'
      : legacy === 'block' && value.reasonCode?.split('|')[0] === 'meta_narration_silenced'
        ? 'skipped'
        : undefined);
  if (outcome === 'reply') return { kind: 'reply', label: '可回复', tone: 'success' } as const;
  if (outcome === 'handoff')
    return { kind: 'handoff', label: '转人工意图', tone: 'warning' } as const;
  if (outcome === 'skipped') return { kind: 'skipped', label: '有意静默', tone: 'info' } as const;
  if (legacy === 'block')
    return { kind: 'legacy_block', label: '历史拦截／未发送', tone: 'danger' } as const;
  return { kind: 'advisory', label: '仅审查建议', tone: 'info' } as const;
}

/** guardrail_input 的读边界：历史 block 不能据此认定已派发人工介入。 */
export function guardrailInputDisplay(decision: 'pass' | 'handoff' | 'block') {
  if (decision === 'handoff')
    return { kind: 'handoff', label: '入站转人工意图', tone: 'warning' } as const;
  if (decision === 'block')
    return { kind: 'legacy_block', label: '历史入站拦截／未发送', tone: 'danger' } as const;
  return { kind: 'pass', label: '预检通过', tone: 'success' } as const;
}
