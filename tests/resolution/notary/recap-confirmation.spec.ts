import {
  createForm,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection/form.types';
import { verifyRecapConfirmationBinding } from '@resolution/notary/recap-confirmation';

const NAME: ContractFieldDef = {
  labelId: 1,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};
const AGE: ContractFieldDef = {
  labelId: 2,
  labelTitle: '年龄',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};
const CONTRACT = [NAME, AGE];
const RECAP_TAIL = '没问题的话我这就帮你提交，有不对的地方直接说改哪项';

function recappedForm(): BookingCollectionForm {
  const form = createForm({ jobId: 100, contract: CONTRACT });
  form.slots[1] = {
    labelId: 1,
    state: 'filled',
    askCount: 0,
    value: { value: '兮兮', sourceText: '档案：兮兮', producer: 'archive' },
  };
  form.slots[2] = {
    labelId: 2,
    state: 'filled',
    askCount: 0,
    value: { value: '25', sourceText: '我25岁', producer: 'candidate_quote' },
  };
  form.lastRecap = { labelIds: [1, 2] };
  return form;
}

function verify(overrides: Partial<Parameters<typeof verifyRecapConfirmationBinding>[0]> = {}) {
  const candidateQuote = '可以的，麻烦了';
  return verifyRecapConfirmationBinding({
    form: recappedForm(),
    contract: CONTRACT,
    recapRequired: true,
    candidateTexts: [candidateQuote],
    messages: [
      { role: 'assistant', content: '帮你核对一下报名信息：\n姓名：兮兮\n年龄：25' },
      { role: 'assistant', content: RECAP_TAIL },
      { role: 'user', content: candidateQuote },
    ],
    candidateQuote,
    recapQuote: RECAP_TAIL,
    hasValidatedCorrection: false,
    ...overrides,
  });
}

describe('recap confirmation notary', () => {
  it('真实相邻问答与连续分段 assistant recap 能机械绑定', () => {
    expect(verify()).toEqual({ accepted: true });
  });

  it('候选人引用必须等于最新完整回复，不得截取肯定子串', () => {
    expect(
      verify({
        candidateTexts: ['没问题，但是电话错了'],
        candidateQuote: '没问题',
        messages: [
          { role: 'assistant', content: `姓名：兮兮\n年龄：25\n${RECAP_TAIL}` },
          { role: 'user', content: '没问题，但是电话错了' },
        ],
      }),
    ).toEqual({ accepted: false, reason: 'candidate_quote_not_full_latest_reply' });
  });

  it('未真实发送、引用旧 recap 或不在紧邻 assistant 组的复述均不放行', () => {
    expect(
      verify({
        messages: [{ role: 'user', content: '可以的，麻烦了' }],
      }),
    ).toEqual({ accepted: false, reason: 'recap_quote_not_in_adjacent_assistant_group' });

    expect(
      verify({
        messages: [
          { role: 'assistant', content: `姓名：兮兮\n年龄：25\n${RECAP_TAIL}` },
          { role: 'user', content: '稍等' },
          { role: 'assistant', content: '今天天气不错' },
          { role: 'user', content: '可以的，麻烦了' },
        ],
      }),
    ).toEqual({ accepted: false, reason: 'recap_quote_not_in_adjacent_assistant_group' });
  });

  it('当前表单快照与 assistant recap 不一致时拒绝陈旧确认', () => {
    const stale = recappedForm();
    stale.slots[2].value = { value: '26', sourceText: '我26岁', producer: 'candidate_quote' };
    expect(verify({ form: stale })).toEqual({ accepted: false, reason: 'recap_snapshot_mismatch' });
  });

  it('同轮已验证 correct/clear 时纠正优先，recap 不得 affirmed', () => {
    expect(verify({ hasValidatedCorrection: true })).toEqual({
      accepted: false,
      reason: 'correction_takes_precedence',
    });
  });

  it('无外部预填的表单不接受 recap 确认旁路', () => {
    const direct = recappedForm();
    direct.slots[1].value = {
      value: '兮兮',
      sourceText: '我叫兮兮',
      producer: 'candidate_quote',
    };
    expect(verify({ form: direct, recapRequired: false })).toEqual({
      accepted: false,
      reason: 'recap_not_required',
    });
  });
});
