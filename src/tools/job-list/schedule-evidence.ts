// business-rules: SH-05
import { z } from 'zod';
import { verifyCitation } from '@resolution/notary/citation-verifier';
import type { VerifiedCollectionAnswer } from '@shared-types/turn.types';

export const ScheduleCitationSchema = z.union([
  z.object({ quote: z.string().min(1) }),
  z.object({ collectionAnswerIds: z.array(z.string().min(1)).min(1).max(10) }),
]);

/** 只公证来源；约束的正负方向、是否排他仍由 Agent 结合字段问题理解。 */
export function verifyScheduleCitation(
  citation: z.infer<typeof ScheduleCitationSchema> | undefined,
  currentUserMessage: string,
  answers: readonly VerifiedCollectionAnswer[],
): boolean {
  if (!citation) return false;
  if ('quote' in citation) return verifyCitation(citation, [currentUserMessage]).verified;
  return (
    citation.collectionAnswerIds.length > 0 &&
    citation.collectionAnswerIds.every((id) => answers.some((answer) => answer.id === id))
  );
}
