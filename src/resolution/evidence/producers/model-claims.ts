import {
  isCandidateClaimField,
  type CandidateClaimField,
  type CandidateClaimInput,
  type CandidateFactClaim,
} from '../claim.types';

/**
 * 模型 producer（方案 §9 model-claim.producer + §10 兼容策略）。
 *
 * 两条入口：
 * 1. `produceModelClaims`：模型经 precheck `candidateClaims` 显式提交的声明
 *    （带 quote），producer='model'。这是方案 §6.1 的目标形态——模型提交它对
 *    候选人消息的结构化理解，裁决器验证 quote 与值。
 * 2. `produceLegacyModelClaims`：旧裸字段入参（candidateName/candidatePhone/…）
 *    转译成无 quote 的 legacy claim（§10-2"旧字段在 precheck 内转换为 legacy
 *    model claim"）。裁决器对无 quote claim 走候选人全文推导：推得出等价值 →
 *    accepted（有据），推不出 → rejected（模型从 Prompt 复制旧值的自证被关闭）。
 */

export function produceModelClaims(
  inputs: readonly CandidateClaimInput[],
  assertedAt: string,
): CandidateFactClaim[] {
  return inputs.map((input, index) => ({
    claimId: `model_${input.field}_${index + 1}`,
    field: input.field,
    value: input.operation === 'clear' ? null : input.value,
    operation: input.operation ?? 'set',
    producer: 'model',
    interpretation: 'direct',
    evidence: { quote: input.quote.trim() },
    reasoning: input.reasoning,
    assertedAt,
  }));
}

/** 裸字段入参名 → Claim 字段名（值已经工具侧 normalize*Input 归一为字符串）。 */
export type LegacyCandidateArgs = Partial<Record<CandidateClaimField, string | number | boolean>>;

export function produceLegacyModelClaims(
  args: LegacyCandidateArgs,
  assertedAt: string,
): CandidateFactClaim[] {
  const claims: CandidateFactClaim[] = [];
  let sequence = 0;
  for (const [field, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    if (!isCandidateClaimField(field)) continue;
    claims.push({
      claimId: `legacy_${field}_${(sequence += 1)}`,
      field,
      value,
      operation: 'set',
      producer: 'model',
      interpretation: 'direct',
      // 无 quote：裁决器在候选人全文中确定性推导，推不出即 rejected。
      evidence: { quote: '' },
      reasoning: '旧裸字段入参转译（§10 双读兼容）',
      assertedAt,
    });
  }
  return claims;
}
