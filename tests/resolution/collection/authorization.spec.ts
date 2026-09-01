import {
  isCollectionAuthorized,
  isSubmissionAuthorized,
  needsRecap,
} from '@resolution/collection/authorization';
import { createForm, type BookingCollectionForm, type ContractFieldDef } from '@resolution/collection/form.types';
import { LEGACY_COLLECTION_SNAPSHOT_COMPAT_UNTIL } from '@resolution/notary/legacy-collection-snapshot';
import type { CandidateFactProducer } from '@resolution/candidate/types';

const FIELD: ContractFieldDef = {
  labelId: 1,
  labelTitle: '专业',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};

function readyForm(producer: CandidateFactProducer = 'candidate_quote'): BookingCollectionForm {
  const form = createForm({ jobId: 100, contract: [FIELD] });
  form.slots[1] = {
    labelId: 1,
    state: 'filled',
    askCount: 0,
    value: { value: '无', sourceText: '专业：无', producer },
  };
  return form;
}

describe('collection authorization', () => {
  it.each(['candidate_quote', 'rule', 'model'] as const)(
    '候选人表达通道 %s 不需 recap，ready 即资料授权',
    (producer) => {
      const form = readyForm(producer);
      expect(needsRecap(form)).toBe(false);
      expect(isCollectionAuthorized(form)).toBe(true);
    },
  );

  it.each(['archive', 'system', 'manual'] as const)(
    '外部预填通道 %s 必须 recap 后才资料授权',
    (producer) => {
      const form = readyForm(producer);
      form.lastRecap = { labelIds: [1] };
      expect(needsRecap(form)).toBe(true);
      expect(isCollectionAuthorized(form)).toBe(false);
      form.lastRecap.affirmed = true;
      expect(isCollectionAuthorized(form)).toBe(true);
    },
  );

  it('3 天兼容窗内老 medium 快照保守触发 recap，high 与到期后不触发', () => {
    const medium = readyForm() as BookingCollectionForm & {
      slots: Record<number, { value: { confidence?: string } }>;
    };
    medium.slots[1].value.confidence = 'medium';
    expect(needsRecap(medium, LEGACY_COLLECTION_SNAPSHOT_COMPAT_UNTIL - 1)).toBe(true);
    expect(needsRecap(medium, LEGACY_COLLECTION_SNAPSHOT_COMPAT_UNTIL)).toBe(false);

    medium.slots[1].value.confidence = 'high';
    expect(needsRecap(medium, LEGACY_COLLECTION_SNAPSHOT_COMPAT_UNTIL - 1)).toBe(false);
  });

  it('非 ready 表单不授权', () => {
    expect(isCollectionAuthorized(createForm({ jobId: 100, contract: [FIELD] }))).toBe(false);
  });

  it('统一提交闸：wait_notice 只需资料授权，普通岗还需精确草稿与实时可约', () => {
    const form = readyForm();
    expect(
      isSubmissionAuthorized({
        form,
        waitNotice: true,
        interviewTimeBookingAllowed: false,
      }),
    ).toBe(true);

    form.scheduleDraft = {
      requestedDate: '2026-09-01',
      selectedInterviewTime: '2026-09-01 10:00-11:00',
      sourceText: '我9月1日10点可以',
    };
    const base = {
      form,
      waitNotice: false,
      interviewTime: '2026-09-01 10:00-11:00',
    };
    expect(isSubmissionAuthorized({ ...base, interviewTimeBookingAllowed: true })).toBe(true);
    expect(
      isSubmissionAuthorized({
        ...base,
        interviewTime: '2026-09-01 14:00-15:00',
        interviewTimeBookingAllowed: true,
      }),
    ).toBe(false);
    expect(isSubmissionAuthorized({ ...base, interviewTimeBookingAllowed: false })).toBe(false);
  });

  describe('窗口制岗位：草稿落窗口起点，候选人约的是窗口内时刻', () => {
    /**
     * 生产死锁 chat 6a966d1f：岗位窗口 10:00-18:00，模型只传 requestedDate='2026-09-03'，
     * reconcileScheduleDraft 把草稿落到窗口起点 10:00:00；候选人说「两点半」，booking 按
     * slot 的 interviewTimeHint 提交 14:30:00 → 与草稿逐字不等 → 连续 8 次 booking.rejected，
     * 候选人答「好的」「对」「确认提交」都出不去。
     */
    const WINDOW_SLOT = {
      date: '2026-09-03',
      bookingAllowed: true,
      interviewTime: '2026-09-03 10:00:00',
      startTime: '10:00',
      endTime: '18:00',
      interviewTimeFlexible: true,
    };

    const draftedForm = () => {
      const form = readyForm();
      form.scheduleDraft = {
        requestedDate: '2026-09-03',
        selectedInterviewTime: '2026-09-03 10:00:00',
        sourceText: '对',
      };
      return form;
    };

    const authorize = (interviewTime: string, liveSlots = [WINDOW_SLOT]) =>
      isSubmissionAuthorized({
        form: draftedForm(),
        waitNotice: false,
        interviewTime,
        interviewTimeBookingAllowed: true,
        liveSlots,
      });

    it('回归：候选人约的窗口内时刻获授权（14:30 在 10:00-18:00 内）', () => {
      expect(authorize('2026-09-03 14:30:00')).toBe(true);
    });

    it('窗口边界含端点', () => {
      expect(authorize('2026-09-03 10:00:00')).toBe(true);
      expect(authorize('2026-09-03 18:00:00')).toBe(true);
    });

    it('窗口外时刻仍拒绝', () => {
      expect(authorize('2026-09-03 09:59:00')).toBe(false);
      expect(authorize('2026-09-03 18:01:00')).toBe(false);
    });

    it('换日期不放行（草稿锚定的是候选人同意的那一天）', () => {
      expect(authorize('2026-09-04 14:30:00')).toBe(false);
    });

    it('非窗口制 slot 不放宽：仍要求逐字相等', () => {
      const fixed = { ...WINDOW_SLOT, interviewTimeFlexible: false };
      expect(authorize('2026-09-03 14:30:00', [fixed])).toBe(false);
      expect(authorize('2026-09-03 10:00:00', [fixed])).toBe(true);
    });

    it('不传 liveSlots 时行为与放宽前一致（只认逐字相等）', () => {
      const form = draftedForm();
      expect(
        isSubmissionAuthorized({
          form,
          waitNotice: false,
          interviewTime: '2026-09-03 14:30:00',
          interviewTimeBookingAllowed: true,
        }),
      ).toBe(false);
    });

    it('资料未授权时，窗口放宽不得越过资料闸', () => {
      const form = createForm({ jobId: 100, contract: [FIELD] });
      form.scheduleDraft = {
        requestedDate: '2026-09-03',
        selectedInterviewTime: '2026-09-03 10:00:00',
        sourceText: '对',
      };
      expect(
        isSubmissionAuthorized({
          form,
          waitNotice: false,
          interviewTime: '2026-09-03 14:30:00',
          interviewTimeBookingAllowed: true,
          liveSlots: [WINDOW_SLOT],
        }),
      ).toBe(false);
    });
  });
});
