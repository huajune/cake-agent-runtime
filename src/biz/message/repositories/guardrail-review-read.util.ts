import type {
  GuardrailTurnTrace,
  GuardViolation,
  OutputDecision,
  OutputResolution,
} from '@shared-types/guardrail.contract';

/** 历史数据库/JSONB 的读边界；旧枚举不进入执行与写入契约。 */
export function readOutputDecision(value: unknown): OutputDecision {
  if (value === 'pass' || value === 'observe' || value === 'repair' || value === 'replan') {
    return value;
  }
  if (value === 'revise' || value === 'block') return 'repair';
  return 'observe';
}

export function readOutputOutcome(
  value: unknown,
  reasonCode?: string,
): OutputResolution['outcome'] | undefined {
  if (value === 'reply' || value === 'handoff' || value === 'skipped') return value;
  if (value === 'pass' || value === 'observe') return 'reply';
  // 仅元叙述有确定的历史静默语义；其他旧 block 保留历史归因，不猜最终处置。
  if (value === 'block' && reasonCode?.split('|')[0] === 'meta_narration_silenced')
    return 'skipped';
  return undefined;
}

export function readGuardViolations(values: GuardViolation[] | null): GuardViolation[] {
  return (values ?? []).map((value) => {
    const { recoverability, ...violation } = value as GuardViolation & { recoverability?: string };
    const allowFailOpen =
      violation.allowFailOpen ??
      (recoverability === 'non_recoverable'
        ? false
        : recoverability === 'recoverable'
          ? true
          : undefined);
    return allowFailOpen === undefined ? violation : { ...violation, allowFailOpen };
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function readGuardrailTrace(
  value: unknown,
): (GuardrailTurnTrace & { legacyFinalDecision?: 'block' }) | undefined {
  const trace = record(value);
  if (!trace || !Array.isArray(trace.steps)) return undefined;
  const reasonCode = typeof trace.reasonCode === 'string' ? trace.reasonCode : undefined;
  const legacyFinal = trace.finalDecision ?? trace.legacyFinalDecision;
  const finalOutcome = readOutputOutcome(trace.finalOutcome ?? legacyFinal, reasonCode);
  return {
    steps: trace.steps.flatMap((value) => {
      const step = record(value);
      if (!step || (step.stage !== 'first' && step.stage !== 'revised')) return [];
      return [
        {
          stage: step.stage,
          decision: readOutputDecision(step.decision),
          riskLevel:
            step.riskLevel === 'high' || step.riskLevel === 'medium' ? step.riskLevel : 'low',
          ruleIds: strings(step.ruleIds),
          blockedRuleIds: strings(step.blockedRuleIds),
          violationTypes: strings(step.violationTypes),
          repairMode: step.repairMode === 'replan' ? 'replan' : 'rewrite',
          reasonCode: typeof step.reasonCode === 'string' ? step.reasonCode : undefined,
        },
      ];
    }),
    repaired: trace.repaired === true,
    finalOutcome,
    ...(legacyFinal === 'block' && !finalOutcome ? { legacyFinalDecision: 'block' as const } : {}),
    reasonCode,
  };
}
