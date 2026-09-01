import type { CandidateFactProducer } from '@resolution/candidate/types';
import { hasLegacyMediumSlotEvidence } from '@resolution/notary/legacy-collection-snapshot';
import type { LiveBookableInterviewSlot } from './form-writes';
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
 *
 * 窗口制岗位放宽为「同一窗口内」而非逐字相等：`reconcileScheduleDraft` 对只给了日期的
 * 请求会把草稿落到该 slot 的**窗口起点**（10:00-18:00 → 10:00:00），而 slot 自己的
 * `interviewTimeHint` 明确教模型「候选人说了窗口内的具体时刻就按他说的提交，不要改写成
 * 窗口起点」。两者相撞时，候选人约的 14:30 与草稿的 10:00 永远不等——生产实录里
 * booking 连续 8 次 `booking.rejected`，候选人答了「好的」「对」「确认提交」也出不去
 * （chat 6a966d1f）。时刻本身的合法性由 booking 侧 validateInterviewTimeAgainstSchedule
 * 按窗口区间独立把关，这里只需确认「候选人同意的就是这个 slot」。
 *
 * liveSlots 缺省时行为与放宽前完全一致（只认逐字相等），不影响非窗口制岗位。
 */
export function isSubmissionAuthorized(input: {
  form: BookingCollectionForm;
  waitNotice: boolean;
  interviewTime?: string;
  interviewTimeBookingAllowed: boolean;
  /** 本轮实时 slot；提供后窗口制岗位允许提交草稿同窗口内的其它时刻。 */
  liveSlots?: readonly LiveBookableInterviewSlot[];
}): boolean {
  if (!isCollectionAuthorized(input.form)) return false;
  if (input.waitNotice) return true;
  if (input.interviewTime === undefined || !input.interviewTimeBookingAllowed) return false;

  const selected = input.form.scheduleDraft?.selectedInterviewTime;
  if (selected !== undefined && selected === input.interviewTime) return true;
  return isWithinDraftedFlexibleWindow(selected, input.interviewTime, input.liveSlots);
}

/** 提交时刻是否落在「草稿所选 slot」的窗口内（仅窗口制 slot 放行）。 */
function isWithinDraftedFlexibleWindow(
  selectedInterviewTime: string | undefined,
  interviewTime: string,
  liveSlots: readonly LiveBookableInterviewSlot[] = [],
): boolean {
  if (!selectedInterviewTime) return false;
  const [date, hms] = interviewTime.split(' ');
  const minutes = toMinutes(hms);
  if (!date || minutes === null) return false;

  return liveSlots.some((slot) => {
    if (!slot.bookingAllowed || !slot.interviewTimeFlexible) return false;
    if (slot.interviewTime !== selectedInterviewTime || slot.date !== date) return false;
    const start = toMinutes(slot.startTime);
    const end = toMinutes(slot.endTime);
    return start !== null && end !== null && minutes >= start && minutes <= end;
  });
}

/** `HH:mm` / `HH:mm:ss` → 当日分钟数；解析不出返回 null（不猜）。 */
function toMinutes(value?: string): number | null {
  const match = value?.match(/^(\d{1,2}):(\d{2})/u);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}
