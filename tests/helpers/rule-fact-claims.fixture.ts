import type {
  RuleFactClaim,
  RuleFactClaims,
  RuleFactConfidence,
  RuleFactFieldPath,
} from '@resolution/evidence/claim.types';

let sequence = 0;

export function testRuleFact(
  field: RuleFactFieldPath,
  value: unknown,
  evidence: string,
  options: {
    confidence?: RuleFactConfidence;
    producer?: RuleFactClaim['producer'];
  } = {},
): RuleFactClaim {
  const producer = options.producer ?? 'rule';
  return {
    claimId: `${producer}_${field.replace('.', '_')}_test_${(sequence += 1)}`,
    field,
    value,
    operation: 'set',
    producer,
    interpretation: 'direct',
    confidence: options.confidence ?? 'high',
    evidence: { quote: evidence, label: evidence },
    assertedAt: '2026-08-11T00:00:00.000Z',
  };
}

export function testRuleFacts(...claims: RuleFactClaim[]): RuleFactClaims {
  return {
    claims,
    reasoning: claims.map((claim) => claim.evidence.label).join('\n'),
  };
}
