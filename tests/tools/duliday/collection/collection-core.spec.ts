import {
  deriveCollectionAction,
  hasRestrictedAnswerThisTurn,
  runCollectionCore,
} from '@tools/duliday/collection/collection-core';
import { createForm, verdictOf, type ContractFieldDef } from '@resolution/collection';

const NAME: ContractFieldDef = {
  labelId: 769,
  labelTitle: '姓名',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'name',
};
const AGE: ContractFieldDef = {
  labelId: 687,
  labelTitle: '年龄',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'age',
  valueSpec: { kind: 'number', min: 20, max: 50, unit: '岁', genderRanges: [] },
};
const HEALTH: ContractFieldDef = {
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
const HOMETOWN: ContractFieldDef = {
  labelId: 3,
  labelTitle: '籍贯',
  fieldType: 'SINGLE_OPTION',
  required: true,
  disclosure: 'RESTRICTED',
  acceptedOptions: [{ optionCode: '310000', optionLabel: '上海市' }],
  rejectedOptions: [{ optionCode: '120000', optionLabel: '天津市' }],
};

const CONTRACT = [NAME, AGE, HEALTH];

function run(text: string, overrides: Partial<Parameters<typeof runCollectionCore>[0]> = {}) {
  return runCollectionCore({
    form: createForm({ jobId: 528962, contract: CONTRACT }),
    contract: CONTRACT,
    candidateTexts: [text],
    messages: [{ role: 'user', content: text }],
    ...overrides,
  });
}

describe('deriveCollectionAction · nextAction 唯一派生点', () => {
  it('五个 verdict 各自对应一个 Agent 动作，语义与既有契约同名', () => {
    expect(deriveCollectionAction('collecting')).toBe('collect_fields');
    expect(deriveCollectionAction('ready')).toBe('ready_to_book');
    expect(deriveCollectionAction('disqualified')).toBe('screening_rejected');
    expect(deriveCollectionAction('escalated')).toBe('handoff');
    expect(deriveCollectionAction('submitted')).toBe('already_submitted');
  });
});

describe('runCollectionCore · 先写后问', () => {
  it('本轮答的字段当轮入槽，不出现在待问清单里（答后复问的机械成因根治）', () => {
    const result = run('我叫兮兮，今年26岁');
    expect(result.template.knownFieldMap['年龄']).toBe('26');
    expect(result.template.missingFields).not.toContain('年龄');
    expect(result.askableFields).not.toContain('年龄');
  });

  it('缺的字段进 missingFields 并可问', () => {
    const result = run('我今年26岁');
    expect(result.template.missingFields).toEqual(['姓名', '有无本地健康证']);
    expect(result.askableFields).toEqual(['姓名', '有无本地健康证']);
    expect(result.action).toBe('collect_fields');
  });

  it('模板一次性列全部字段——分批发清单是明令禁止的漏斗式收资', () => {
    const result = run('我今年26岁');
    for (const title of ['姓名', '年龄', '有无本地健康证']) {
      expect(result.template.templateText).toContain(`${title}：`);
    }
  });

  it('收齐即 ready_to_book', () => {
    const text = '我叫兮兮，今年26岁，有本地有效健康证';
    const result = runCollectionCore({
      form: createForm({ jobId: 528962, contract: CONTRACT }),
      contract: CONTRACT,
      candidateTexts: [text],
      messages: [{ role: 'user', content: text }],
      claims: [
        { field: 'name', value: '兮兮', quote: '我叫兮兮' },
        { field: 'age', value: '26', quote: '今年26岁' },
        { field: 'healthCertificate', value: '有本地有效健康证', quote: '有本地有效健康证' },
      ],
    });
    expect(result.verdict).toBe('ready');
    expect(result.action).toBe('ready_to_book');
    expect(result.template.missingFields).toEqual([]);
  });
});

describe('runCollectionCore · 筛选与审计', () => {
  it('命中 rejectedOptions → screening_rejected + 审计事件', () => {
    const text = '没有健康证，我不愿意办';
    const result = run(text, {
      candidateTexts: [text],
      messages: [{ role: 'user', content: text }],
    });
    expect(result.action).toBe('screening_rejected');
    expect(result.audits.some((a) => a.kind === 'slot_disqualified' && a.labelId === 13)).toBe(
      true,
    );
  });

  it('值域越界 → 同样 screening_rejected（判据读契约 valueSpec）', () => {
    const text = '我今年58岁';
    const result = run(text);
    expect(result.action).toBe('screening_rejected');
  });

  it('公证拒收落审计事件——臆造防线的观测面，不能只打日志', () => {
    const result = run('你好还招人吗', {
      claims: [{ field: 'age', value: '30', quote: '我30岁' }],
    });
    const rejected = result.audits.find((a) => a.kind === 'proposal_rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.channel).toBe('claim');
    expect(rejected?.reason).toBe('source_text_not_found');
  });

  it('熔断：同槽问满上限 → handoff，askableFields 空', () => {
    let form = createForm({ jobId: 528962, contract: CONTRACT });
    for (let turn = 0; turn < 3; turn += 1) {
      const result = runCollectionCore({
        form,
        contract: CONTRACT,
        candidateTexts: ['嗯'],
        messages: [{ role: 'user', content: '嗯' }],
      });
      form = result.form;
      if (turn < 2) expect(result.action).toBe('collect_fields');
    }
    expect(verdictOf(form)).toBe('escalated');
    const final = runCollectionCore({
      form,
      contract: CONTRACT,
      candidateTexts: ['嗯'],
      messages: [{ role: 'user', content: '嗯' }],
    });
    expect(final.action).toBe('handoff');
    expect(final.askableFields).toEqual([]);
  });

  it('askThisTurn=false 时只写不问，不消耗熔断配额', () => {
    const result = run('我今年26岁', { askThisTurn: false });
    expect(result.askableFields).toEqual([]);
    expect(result.form.slots[769].askCount).toBe(0);
  });
});

describe('因果隔离判据', () => {
  it('本轮刚答过禁明说档字段 → 拒绝顺延', () => {
    expect(hasRestrictedAnswerThisTurn([HOMETOWN])).toBe(true);
    expect(hasRestrictedAnswerThisTurn([NAME, AGE])).toBe(false);
  });

  it('answeredThisTurn 只含本轮真正落值的字段', () => {
    const result = run('我今年26岁');
    expect(result.answeredThisTurn.map((f) => f.labelId)).toEqual([687]);
  });
});

describe('模板字段名与契约同源', () => {
  it('字段名一律用契约 labelTitle，脏标题在模板行里剥括号（不泄露筛选指令）', () => {
    const dirty: ContractFieldDef = {
      labelId: 605,
      labelTitle: '是否学生（不要学生及暑假工）',
      fieldType: 'SINGLE_OPTION',
      required: true,
      acceptedOptions: [{ optionCode: 's2', optionLabel: '社会人士' }],
      rejectedOptions: [],
    };
    const result = runCollectionCore({
      form: createForm({ jobId: 1, contract: [dirty] }),
      contract: [dirty],
      candidateTexts: [''],
      messages: [],
    });
    expect(result.template.missingFields).toEqual(['是否学生（不要学生及暑假工）']);
    expect(result.template.templateText).toContain('是否学生：');
    expect(result.template.templateText).not.toContain('不要学生及暑假工');
  });
});
