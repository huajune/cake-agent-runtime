import { reconcileScheduleDraft } from '@resolution/collection/form-writes';
import { createForm, type ContractFieldDef } from '@resolution/collection/form.types';

const FIELD: ContractFieldDef = {
  labelId: 1,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};
const SLOT_A = '2026-09-01 10:00-11:00';
const SLOT_B = '2026-09-01 14:00-15:00';
const SLOT_C = '2026-09-02 10:00-11:00';

const liveSlots = [
  { date: '2026-09-01', interviewTime: SLOT_A, bookingAllowed: true },
  { date: '2026-09-01', interviewTime: SLOT_B, bookingAllowed: true },
  { date: '2026-09-02', interviewTime: SLOT_C, bookingAllowed: true },
];

describe('reconcileScheduleDraft', () => {
  it('只从可回查的候选人原话建立草稿，精确 slot 必须实时可约', () => {
    const form = reconcileScheduleDraft(createForm({ jobId: 100, contract: [FIELD] }), {
      waitNotice: false,
      liveSlots,
      candidateTexts: ['我选9月1日上午10点'],
      requestedDate: '2026-09-01',
      selectedInterviewTime: SLOT_A,
      sourceText: '我选9月1日上午10点',
    });
    expect(form.scheduleDraft).toEqual({
      requestedDate: '2026-09-01',
      selectedInterviewTime: SLOT_A,
      sourceText: '我选9月1日上午10点',
    });
  });

  it('日期只命中一个时段时自动选中，同日多时段只保留日期', () => {
    const unique = reconcileScheduleDraft(createForm({ jobId: 100, contract: [FIELD] }), {
      waitNotice: false,
      liveSlots,
      candidateTexts: ['9月2日可以'],
      requestedDate: '2026-09-02',
      sourceText: '9月2日可以',
    });
    expect(unique.scheduleDraft?.selectedInterviewTime).toBe(SLOT_C);

    const ambiguous = reconcileScheduleDraft(createForm({ jobId: 100, contract: [FIELD] }), {
      waitNotice: false,
      liveSlots,
      candidateTexts: ['9月1日可以'],
      requestedDate: '2026-09-01',
      sourceText: '9月1日可以',
    });
    expect(ambiguous.scheduleDraft).toEqual({
      requestedDate: '2026-09-01',
      sourceText: '9月1日可以',
    });
  });

  it('模糊或伪造出处不写入，不会因资料仍缺失而丢掉已有有效选择', () => {
    const initial = reconcileScheduleDraft(createForm({ jobId: 100, contract: [FIELD] }), {
      waitNotice: false,
      liveSlots,
      candidateTexts: ['9月2日可以'],
      requestedDate: '2026-09-02',
      sourceText: '9月2日可以',
    });
    const persisted = reconcileScheduleDraft(initial, {
      waitNotice: false,
      liveSlots,
      candidateTexts: ['我叫兮兮'],
      requestedDate: '2026-09-01',
      sourceText: '模型自己编的时间',
    });
    expect(persisted.scheduleDraft).toEqual(initial.scheduleDraft);
  });

  it('已选 slot 失效时只清 selectedInterviewTime，保留日期与已收资料', () => {
    const form = createForm({ jobId: 100, contract: [FIELD] });
    form.slots[1] = {
      labelId: 1,
      state: 'filled',
      askCount: 0,
      value: { value: '兮兮', sourceText: '我叫兮兮', producer: 'candidate_quote' },
    };
    form.scheduleDraft = {
      requestedDate: '2026-09-01',
      selectedInterviewTime: SLOT_A,
      sourceText: '我9月1日10点可以',
    };
    const refreshed = reconcileScheduleDraft(form, {
      waitNotice: false,
      liveSlots: liveSlots.filter((slot) => slot.interviewTime !== SLOT_A),
      candidateTexts: [],
    });
    expect(refreshed.scheduleDraft).toEqual({
      requestedDate: '2026-09-01',
      sourceText: '我9月1日10点可以',
    });
    expect(refreshed.slots[1].value?.value).toBe('兮兮');
  });

  it('wait_notice 清除草稿；新 jobId 创建的表单不继承旧岗位时间', () => {
    const oldForm = createForm({ jobId: 100, contract: [FIELD] });
    oldForm.scheduleDraft = {
      requestedDate: '2026-09-01',
      selectedInterviewTime: SLOT_A,
      sourceText: '我9月1日10点可以',
    };
    expect(
      reconcileScheduleDraft(oldForm, {
        waitNotice: true,
        liveSlots,
        candidateTexts: [],
      }).scheduleDraft,
    ).toBeUndefined();
    expect(createForm({ jobId: 200, contract: [FIELD] }).scheduleDraft).toBeUndefined();
  });
});
