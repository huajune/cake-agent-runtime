import {
  findLatestExplicitIdentityEvidence,
  resolveIdentityFlipAfterRejection,
  type IdentityEvidence,
} from '@tools/shared/identity-statement.util';
import type { CandidateFactClaim } from '../candidate-fact-claim.types';

/**
 * 身份 producer（方案 §8 Phase 1）：把既有 IdentityEvidence 适配为
 * CandidateFactClaim<boolean>（isStudent）。
 *
 * 唯一识别器仍是 identity-statement.util（方案 §2 契约：不平行建设第二套
 * 身份正则）；本模块只做形态适配与改口核实语义的桥接：
 * - direct / form_answer / choice_answer → interpretation='direct'；
 * - confirmation（确认问句+肯定应答）→ interpretation='context_confirmation'；
 * - "学生被拒后改口社会人士"未完成二次核实时（resolveIdentityFlipAfterRejection
 *   flipPendingVerification=true），不产 claim——策略性改口在核实完成前不构成
 *   有效证据（方案 §5.3-4 复用现有二次核实策略）。
 */

export interface ProduceIdentityClaimParams {
  /** 完整会话消息（identity 识别器自带清洗，吃原始形态）。 */
  messages: unknown[];
  assertedAt: string;
}

function toClaim(evidence: IdentityEvidence, assertedAt: string): CandidateFactClaim<boolean> {
  return {
    claimId: `identity_isStudent_1`,
    field: 'isStudent',
    value: evidence.identity === '学生',
    operation: 'set',
    producer: evidence.source === 'confirmation' ? 'confirmation_resolver' : 'rule',
    interpretation: evidence.source === 'confirmation' ? 'context_confirmation' : 'direct',
    evidence: {
      quote: evidence.evidence.slice(0, 200),
      // 确认式证据的问句在 assistant 侧，识别器未单独回传问句原文；
      // 值验证走 quote（应答原文含身份词或由识别器状态机担保）。
      messageIndex: evidence.messageIndex,
    },
    assertedAt,
  };
}

export function produceIdentityClaim(
  params: ProduceIdentityClaimParams,
): CandidateFactClaim<boolean> | null {
  const evidence = findLatestExplicitIdentityEvidence(params.messages);
  if (!evidence) return null;

  // 拒后改口未核实：社会人士方向的最新自认暂不入裁决（学生方向不受限）。
  if (evidence.identity === '社会人士') {
    const { flipPendingVerification } = resolveIdentityFlipAfterRejection(params.messages);
    if (flipPendingVerification) return null;
  }
  return toClaim(evidence, params.assertedAt);
}
