/**
 * §10.1 实案回归：0819 确认死循环（用户裁定"本改造必须完全修复"，验收必测）。
 *
 * 案例 chat `6a829f44ce406a6aee9369f0`（2026-08-19 17:02-17:28，v10.44.0 首日，
 * handoff_events.reason_code='system_blocked' 公证死循环族 3 会话之一）。故障链：
 * 候选人 17:07 一次给全住址/社会身份/健康证 → 复述确认后 booking 因模型未转抄
 * prechecked 被拒 → 重跑 precheck 时"确认"无作证通道、跨轮原话进不了当轮证据窗、
 * 补充标签在 claim 运输里无座位 → checklist 恒缺 → 整发清单再确认 ×2 → 熔断发人工卡。
 *
 * 契约字段按 0820 生产实测（jobId 528962 的 7 个标签，含案发时涉及的三项：
 * 具体住址[756] / 社会身份[1] / 有无本地健康证[13]）。
 * 身份一律假身份（兮兮 / 18271421690）。
 */

import {
  applyRecapResult,
  createForm,
  emptySlotIds,
  filledSlotIds,
  markRecapSent,
  markSubmitted,
  proposeValue,
  verdictOf,
  type BookingCollectionForm,
  type ContractFieldDef,
} from '@resolution/collection';

const NAME: ContractFieldDef = {
  labelId: 769,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};
const PHONE: ContractFieldDef = {
  labelId: 770,
  labelTitle: '手机号',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'phone',
};
const ADDRESS: ContractFieldDef = {
  labelId: 756,
  labelTitle: '具体住址',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};
const SOCIAL_IDENTITY: ContractFieldDef = {
  labelId: 1,
  labelTitle: '社会身份',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [
    { optionCode: '1', optionLabel: '全日制在校学生' },
    { optionCode: '2', optionLabel: '社会人士' },
    { optionCode: '3', optionLabel: '第二职业' },
  ],
  rejectedOptions: [],
};
const HEALTH_CERT: ContractFieldDef = {
  labelId: 13,
  labelTitle: '有无本地健康证',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [
    { optionCode: '1', optionLabel: '有本地有效健康证' },
    { optionCode: '2', optionLabel: '无本地有效健康证，接受办理' },
  ],
  rejectedOptions: [{ optionCode: '3', optionLabel: '无本地有效健康证，不接受办理' }],
};

const CONTRACT = [NAME, PHONE, ADDRESS, SOCIAL_IDENTITY, HEALTH_CERT];
const NAME_TEXT = '姓名：兮兮';
const PHONE_TEXT = '手机号 18271421690';
/** 案发原话形态：一次给全三项。 */
const BULK_TEXT = '具体住址是杨浦区国和路100弄，我是社会人士，有本地有效健康证';

function user(text: string) {
  return { role: 'user' as const, content: text };
}

function fill(
  form: BookingCollectionForm,
  field: ContractFieldDef,
  value: string,
  sourceText: string,
  extra: { optionCodes?: string[]; messages?: readonly unknown[] } = {},
): BookingCollectionForm {
  const result = proposeValue(form, field, {
    value,
    sourceText,
    producer: 'candidate_quote',
    candidateTexts: [sourceText],
    messages: extra.messages ?? [user(sourceText)],
    optionCodes: extra.optionCodes,
  });
  expect(result.outcome).toBe('accepted');
  return result.form;
}

/** 复刻案发序列到"候选人一次给全三项、已可提交"这一刻。 */
function afterBulkAnswer(): BookingCollectionForm {
  let form = createForm({ candidateRef: '18271421690', jobId: 528962, contract: CONTRACT });
  form = fill(form, NAME, '兮兮', NAME_TEXT, { messages: [user(NAME_TEXT)] });
  form = fill(form, PHONE, '18271421690', PHONE_TEXT, { messages: [user(PHONE_TEXT)] });
  form = fill(form, ADDRESS, '杨浦区国和路100弄', BULK_TEXT);
  form = fill(form, SOCIAL_IDENTITY, '社会人士', BULK_TEXT, { optionCodes: ['2'] });
  form = fill(form, HEALTH_CERT, '有本地有效健康证', BULK_TEXT, { optionCodes: ['1'] });
  return form;
}

describe('§10.1 · 0819 确认死循环实案回归', () => {
  it('补充标签全覆盖：住址/社会身份/健康证都有槽位，不存在无座位字段', () => {
    const form = createForm({ jobId: 528962, contract: CONTRACT });
    for (const field of [ADDRESS, SOCIAL_IDENTITY, HEALTH_CERT]) {
      expect(form.slots[field.labelId]).toBeDefined();
    }
    expect(emptySlotIds(form, CONTRACT)).toEqual([769, 770, 756, 1, 13]);
  });

  it('公证一次终身有效：一次给全的值当轮入槽，后续任何轮不再要求重新举证', () => {
    const form = afterBulkAnswer();
    expect(filledSlotIds(form, CONTRACT)).toEqual([769, 770, 756, 1, 13]);
    expect(verdictOf(form)).toBe('ready');

    // 下一轮：证据窗已翻篇（跨轮原话不在当轮语料里）——旧体系正是在这里判"缺"。
    const nextTurn = proposeValue(form, ADDRESS, {
      value: '杨浦区国和路100弄',
      sourceText: BULK_TEXT,
      producer: 'model',
      candidateTexts: ['确认'],
      messages: [user('确认')],
    });
    expect(nextTurn.outcome).toBe('ignored');
    expect(verdictOf(nextTurn.form)).toBe('ready');
    expect(emptySlotIds(nextTurn.form, CONTRACT)).toEqual([]);
  });

  it('确认即放行：复述后回"确认" → verdictOf==="ready" 直接提交', () => {
    const recapped = markRecapSent(afterBulkAnswer(), filledSlotIds(afterBulkAnswer(), CONTRACT));
    const affirmed = applyRecapResult(recapped, { affirmed: true });
    expect(verdictOf(affirmed)).toBe('ready');
    expect(emptySlotIds(affirmed, CONTRACT)).toEqual([]);
  });

  it('第二张全量确认清单在结构上不出现——ready 时没有任何空槽可问', () => {
    let form = afterBulkAnswer();
    // 模拟旧体系的"再确认一轮"：任何路径都产不出待问清单。
    for (let turn = 0; turn < 3; turn += 1) {
      expect(emptySlotIds(form, CONTRACT)).toEqual([]);
      form = markRecapSent(form, filledSlotIds(form, CONTRACT));
      form = applyRecapResult(form, { affirmed: true });
    }
    expect(verdictOf(form)).toBe('ready');
    expect(form.escalatedReason).toBeUndefined();
  });

  it('修正精确重开：「住址是X」+「其他都正确」只重开住址一格，其余保持 filled', () => {
    const ready = markRecapSent(afterBulkAnswer(), [769, 770, 756, 1, 13]);
    const corrected = applyRecapResult(ready, { corrections: [ADDRESS.labelId] });

    expect(corrected.slots[756].state).toBe('empty');
    for (const labelId of [769, 770, 1, 13]) {
      expect(corrected.slots[labelId].state).toBe('filled');
    }
    expect(verdictOf(corrected)).toBe('collecting');
    expect(emptySlotIds(corrected, CONTRACT)).toEqual([756]);
  });

  it('修正值当轮公证后直接提交，不再全量重发清单', () => {
    const ready = markRecapSent(afterBulkAnswer(), [769, 770, 756, 1, 13]);
    const corrected = applyRecapResult(ready, { corrections: [ADDRESS.labelId] });
    const newAddress = '住址是虹口区四平路200号';
    const refilled = proposeValue(corrected, ADDRESS, {
      value: '虹口区四平路200号',
      sourceText: newAddress,
      producer: 'candidate_quote',
      candidateTexts: [newAddress],
      messages: [user(newAddress)],
    });
    expect(refilled.outcome).toBe('accepted');
    expect(verdictOf(refilled.form)).toBe('ready');
    expect(emptySlotIds(refilled.form, CONTRACT)).toEqual([]);
  });

  it('提交票据状态化：提交资格=表单 ready，不存在"模型忘带 prechecked"类序列失败', () => {
    const ready = afterBulkAnswer();
    expect(verdictOf(ready)).toBe('ready');
    const submitted = markSubmitted(ready, 987654);
    expect(verdictOf(submitted)).toBe('submitted');
    expect(submitted.workOrderId).toBe(987654);
  });

  describe('确认可作证（R1 agentQuestionQuote 通道）', () => {
    it('值在 Agent 问句里、应答只有"确认"时照样入账——正是死循环的病根', () => {
      const form = createForm({ jobId: 528962, contract: CONTRACT });
      const question = '帮你核对一下：姓名 兮兮，手机号 18271421690，对吗？';
      const result = proposeValue(form, NAME, {
        value: '兮兮',
        sourceText: '确认',
        producer: 'model',
        candidateTexts: ['确认'],
        messages: [user('确认')],
        agentQuestionQuote: question,
      });
      expect(result.outcome).toBe('accepted');
      expect(result.form.slots[769].state).toBe('filled');
    });

    it('出处门第一问不豁免：应答不是候选人原话即拒（防自问自答绕过公证）', () => {
      const form = createForm({ jobId: 528962, contract: CONTRACT });
      const result = proposeValue(form, NAME, {
        value: '兮兮',
        sourceText: '确认',
        producer: 'model',
        candidateTexts: ['你们还招人吗'],
        messages: [user('你们还招人吗')],
        agentQuestionQuote: '姓名 兮兮，对吗？',
      });
      expect(result.outcome).toBe('rejected');
    });

    it('问句里没有该值 → 确认作证不成立（模型不能借确认塞值）', () => {
      const form = createForm({ jobId: 528962, contract: CONTRACT });
      const result = proposeValue(form, PHONE, {
        value: '18271421690',
        sourceText: '确认',
        producer: 'model',
        candidateTexts: ['确认'],
        messages: [user('确认')],
        agentQuestionQuote: '你的姓名是兮兮，对吗？',
      });
      expect(result.outcome).toBe('rejected');
    });
  });
});
