import type { CandidateFactProducer } from '@resolution/candidate/types';
import { hasLegacyMediumSlotEvidence } from '@resolution/notary/legacy-collection-snapshot';
import type { BookingCollectionForm } from './form.types';
import { verdictOf } from './form.types';

/** 只有候选人本次收集流程之外的来源需要提交前 recap。 */
export const EXTERNAL_PREFILL_PRODUCERS: ReadonlySet<CandidateFactProducer> = new Set([
  'archive',
  'system',
  'manual',
]);

/** ready 表单是否仍含候选人本次收集之外的预填值。 */
export function needsRecap(form: BookingCollectionForm, nowMs = Date.now()): boolean {
  if (hasLegacyMediumSlotEvidence(form, nowMs)) return true;
  return Object.values(form.slots).some(
    (slot) =>
      slot.state === 'filled' &&
      slot.value !== undefined &&
      EXTERNAL_PREFILL_PRODUCERS.has(slot.value.producer),
  );
}

/** 资料是否已经获得用于报名的授权；它不等于最终已经可以提交预约。 */
export function isCollectionAuthorized(form: BookingCollectionForm): boolean {
  if (verdictOf(form) !== 'ready') return false;
  if (!needsRecap(form)) return true;
  return form.lastRecap?.affirmed === true;
}

/**
 * precheck 与 booking 共用的最终提交授权。非 wait_notice 岗位还必须证明本轮精确时段
 * 与持久化草稿一致，并已通过实时可约性复验。
 */
export function isSubmissionAuthorized(input: {
  form: BookingCollectionForm;
  waitNotice: boolean;
  interviewTime?: string;
  interviewTimeBookingAllowed: boolean;
}): boolean {
  if (!isCollectionAuthorized(input.form)) return false;
  if (input.waitNotice) return true;
  return (
    input.interviewTime !== undefined &&
    input.form.scheduleDraft?.selectedInterviewTime === input.interviewTime &&
    input.interviewTimeBookingAllowed
  );
}
