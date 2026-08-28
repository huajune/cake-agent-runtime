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
});
