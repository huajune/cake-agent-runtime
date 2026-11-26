import { z } from 'zod';
import {
  extractPresentedJobs,
  resolveAssistantAnchoredFocusJob,
  resolveCurrentFocusJob,
} from '@resolution/job';
import { RecommendedJobSummarySchema, type RecommendedJobSummary } from '@resolution/job/types';
import type { TurnJobsSnapshot } from '@shared-types/turn.types';
import type { WeworkSessionState } from './short-term.types';
import { compactCandidatePool } from './candidate-pool';

export type ReplyJobContext = Pick<
  TurnJobsSnapshot,
  'fetchedJobs' | 'attestedFocusJob' | 'invalidatedJobIds'
>;

export function selectAssistantJobs(
  userText: string,
  assistantText: string,
  previous: RecommendedJobSummary[],
  pool: RecommendedJobSummary[],
) {
  const presented = extractPresentedJobs(assistantText, pool);
  const focus = resolveCurrentFocusJob(userText, previous, presented, pool);
  return {
    presented,
    focus:
      focus === undefined
        ? (resolveAssistantAnchoredFocusJob(assistantText, previous, presented, pool) ?? undefined)
        : focus,
  };
}

export const replyJobProjectionSchema = z.object({
  jobs: z.array(RecommendedJobSummarySchema.transform((job) => job as RecommendedJobSummary)),
  prefixes: z.array(
    z.object({
      presented: z.array(z.number().int()),
      focus: z.number().int().nullable().optional(),
    }),
  ),
  presentationRound: z.number().int().positive(),
});
export type ReplyJobProjection = z.infer<typeof replyJobProjectionSchema>;

/** Keep only jobs mentioned by an accepted prefix, once each. The original input,
 * candidate pool and tool payloads need not be retained to recover the projection. */
export function planReplyJobProjection(
  segments: string[],
  userText: string,
  state: WeworkSessionState,
  context?: ReplyJobContext,
): ReplyJobProjection | undefined {
  const pool = context?.fetchedJobs?.length
    ? compactCandidatePool(context.fetchedJobs)
    : (state.lastCandidatePool ?? []);
  const previous = state.presentedJobs ?? [];
  const invalid = new Set(context?.invalidatedJobIds);
  const jobs = new Map<number, RecommendedJobSummary>();
  let earlierFocusChanged = false;
  const prefixes = segments.map((_, index) => {
    const selection = selectAssistantJobs(
      userText,
      segments.slice(0, index + 1).join('\n\n'),
      previous,
      pool,
    );
    const presented = selection.presented.filter((job) => !invalid.has(job.jobId));
    let focus = selection.focus;
    if (context?.attestedFocusJob) {
      const attested = context.attestedFocusJob;
      focus =
        [...presented, ...previous, ...pool].find((job) => job.jobId === attested.jobId) ??
        attested;
    }
    // A short prefix can select one store while the whole reply offers a choice.
    // Restore the original focus if the whole accepted text leaves it undecided.
    if (focus === undefined && earlierFocusChanged) focus = state.currentFocusJob ?? null;
    if (focus && invalid.has(focus.jobId)) focus = null;
    if (focus !== undefined) earlierFocusChanged = true;
    for (const job of presented) jobs.set(job.jobId, job);
    if (focus) jobs.set(focus.jobId, focus);
    return {
      presented: presented.map((job) => job.jobId),
      focus: focus === null ? null : focus?.jobId,
    };
  });
  if (!prefixes.some((prefix) => prefix.presented.length || prefix.focus !== undefined))
    return undefined;
  return {
    jobs: [...jobs.values()],
    prefixes,
    presentationRound: (state.storePresentationRounds ?? 0) + 1,
  };
}
