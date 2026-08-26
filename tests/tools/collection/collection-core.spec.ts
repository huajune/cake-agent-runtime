import {
  deriveCollectionAction,
  hasRestrictedAnswerThisTurn,
  runCollectionCore,
} from '@tools/collection/collection-core';
import { createForm, verdictOf, type ContractFieldDef } from '@resolution/collection';
import { selectArchiveFacts } from '@tools/collection/proposal-intake';

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

describe('runCollectionCore · 多人闸（D1：疑似代报第二人即转人工）', () => {
  const PHONE: ContractFieldDef = {
    labelId: 770,
    labelTitle: '手机号',
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'phone',
  };
  const CONTRACT_WITH_PHONE = [NAME, PHONE, AGE];

  function filledPersonOneForm() {
    const text = '我叫兮兮，手机号18271421690';
    const round1 = runCollectionCore({
      form: createForm({ jobId: 528962, contract: CONTRACT_WITH_PHONE }),
      contract: CONTRACT_WITH_PHONE,
      candidateTexts: [text],
      messages: [{ role: 'user', content: text }],
      claims: [
        { field: 'name', value: '兮兮', quote: '我叫兮兮' },
        { field: 'phone', value: '18271421690', quote: '手机号18271421690' },
      ],
    });
    expect(round1.form.slots[769].state).toBe('filled');
    expect(round1.form.slots[770].state).toBe('filled');
    return round1.form;
  }

  it('新姓名+新手机号成对出现 → 本轮零写入、escalated 转人工', () => {
    const text = '再帮李四报一个，他手机号13900001111';
    const result = runCollectionCore({
      form: filledPersonOneForm(),
      contract: CONTRACT_WITH_PHONE,
      candidateTexts: [text],
      messages: [{ role: 'user', content: text }],
      claims: [
        { field: 'name', value: '李四', quote: '帮李四报一个', operation: 'correct' },
        { field: 'phone', value: '13900001111', quote: '手机号13900001111', operation: 'correct' },
      ],
    });
    expect(result.verdict).toBe('escalated');
    expect(result.action).toBe('handoff');
    expect(result.form.escalatedReason).toBe('suspected_multi_person');
    // 零写入：显式改口标记也不放行——第一个人的在案值原样保留
    expect(result.form.slots[769].value?.value).toBe('兮兮');
    expect(result.form.slots[770].value?.value).toBe('18271421690');
    expect(result.audits).toContainEqual(
      expect.objectContaining({ kind: 'escalated', reason: 'suspected_multi_person' }),
    );
  });

  it('只换手机号（自我纠错改口）不触发多人闸，正常 restated 替换', () => {
    const text = '手机号写错了，应该是18271421691';
    const result = runCollectionCore({
      form: filledPersonOneForm(),
      contract: CONTRACT_WITH_PHONE,
      candidateTexts: [text],
      messages: [{ role: 'user', content: text }],
      claims: [
        { field: 'phone', value: '18271421691', quote: '应该是18271421691', operation: 'correct' },
      ],
    });
    expect(result.verdict).not.toBe('escalated');
    expect(result.form.slots[770].value?.value).toBe('18271421691');
    expect(result.audits).toContainEqual(expect.objectContaining({ kind: 'slot_restated' }));
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
    // 单选项不出枚举提示（不是选择题）；标题的括号补充照剥。
    expect(result.template.templateText).toContain('是否学生：');
    expect(result.template.templateText).not.toContain('不要学生及暑假工');
  });
});

describe('记忆→表单预填（跨岗不重复盘问）', () => {
  const archived = [{ claimField: 'age' as const, value: '26', evidence: '我今年26岁' }];

  it('空槽用档案兜底，署名如实（archive/medium，sourceText 带「档案：」前缀）', () => {
    const result = runCollectionCore({
      form: createForm({ jobId: 528962, contract: CONTRACT }),
      contract: CONTRACT,
      candidateTexts: [''],
      messages: [],
      archiveFacts: archived,
    });
    const slot = result.form.slots[687];
    expect(slot.state).toBe('filled');
    expect(slot.value?.producer).toBe('archive');
    expect(slot.value?.confidence).toBe('medium');
    expect(slot.value?.sourceText).toBe('档案：我今年26岁');
    expect(result.template.missingFields).not.toContain('年龄');
  });

  it('**本轮亲口说的优先于档案**——预填在写入之后，不把最好的证据挡在门外', () => {
    const text = '我今年30岁';
    const result = runCollectionCore({
      form: createForm({ jobId: 528962, contract: CONTRACT }),
      contract: CONTRACT,
      candidateTexts: [text],
      messages: [{ role: 'user', content: text }],
      archiveFacts: archived,
    });
    const slot = result.form.slots[687];
    expect(slot.value?.value).toBe('30');
    expect(slot.value?.producer).toBe('candidate_quote');
  });

  it('不覆盖已判不合格的槽位', () => {
    const text = '没有健康证，我不愿意办';
    const disqualified = runCollectionCore({
      form: createForm({ jobId: 528962, contract: CONTRACT }),
      contract: CONTRACT,
      candidateTexts: [text],
      messages: [{ role: 'user', content: text }],
    });
    const seeded = runCollectionCore({
      form: disqualified.form,
      contract: CONTRACT,
      candidateTexts: [''],
      messages: [],
      archiveFacts: [{ claimField: 'healthCertificate' as const, value: '有本地有效健康证' }],
    });
    expect(seeded.form.slots[13].state).toBe('disqualified');
  });

  it('契约没这一项就不预填（该岗不收就是不收）', () => {
    const result = runCollectionCore({
      form: createForm({ jobId: 528962, contract: CONTRACT }),
      contract: CONTRACT,
      candidateTexts: [''],
      messages: [],
      archiveFacts: [{ claimField: 'householdProvince' as const, value: '安徽' }],
    });
    expect(Object.values(result.form.slots).every((s) => s.value?.value !== '安徽')).toBe(true);
  });
});

describe('selectArchiveFacts · 预填来源白名单', () => {
  it('**裸值形态是生产主路径**：context.archive.sessionFacts 已被上游拆信封+高置信过滤', () => {
    // tool-context.builder 传给工具的是 unwrapSessionFacts(facts,{minConfidence:'high'})
    // 的产物——裸值。此前本函数只认信封，在生产里永远返回空，预填是死代码。
    const facts = selectArchiveFacts({
      name: '兮兮',
      age: '26',
      phone: '',
      education: null,
    });
    expect(facts).toEqual([
      { claimField: 'name', value: '兮兮' },
      { claimField: 'age', value: '26' },
    ]);
  });

  it('信封形态仍按产者白名单与置信度过滤（兼容直接传 SessionFacts 的调用方）', () => {
    const facts = selectArchiveFacts({
      name: { value: '兮兮', source: 'candidate_quote', confidence: 'high' },
      age: { value: '26', source: 'system', confidence: 'medium' },
      // 模型自报：badcase 6e9ar9gd 族「臆造档案经沿用洗白」的入口，掐死。
      phone: { value: '13800138000', source: 'model', confidence: 'high' },
      // unknown 档：没人为它的置信度负责过。
      education: { value: '大专', source: 'archive', confidence: 'unknown' },
      // 白名单内但置信度不够。
      gender: { value: '男', source: 'candidate_quote', confidence: 'low' },
    });
    expect(facts.map((f) => f.claimField).sort()).toEqual(['age', 'name']);
  });

  it('空档案返回空', () => {
    expect(selectArchiveFacts(null)).toEqual([]);
    expect(selectArchiveFacts({})).toEqual([]);
  });
});

describe('必填全收 + 筛选项优先（0820 用户确认口径）', () => {
  /** 12 项岗位的形态：身份四槽 + 两个带筛的 + 一堆纯登记项。 */
  const REGISTRATION_A: ContractFieldDef = {
    labelId: 756,
    labelTitle: '具体住址',
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
  };
  const REGISTRATION_B: ContractFieldDef = {
    ...REGISTRATION_A,
    labelId: 749,
    labelTitle: '预计在岗多久',
  };
  const TENURE_SCREEN: ContractFieldDef = {
    labelId: 750,
    labelTitle: '能做多久',
    fieldType: 'SINGLE_OPTION',
    required: true,
    acceptedOptions: [{ optionCode: 'a', optionLabel: '半年以上' }],
    rejectedOptions: [{ optionCode: 'c', optionLabel: '3个月内' }],
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
  // 契约原序刻意把登记项排在筛选项前面，用来验证重排真的生效。
  const BIG_CONTRACT = [REGISTRATION_A, TENURE_SCREEN, NAME, REGISTRATION_B, HEALTH, PHONE, AGE];

  const runBig = () =>
    runCollectionCore({
      form: createForm({ jobId: 528962, contract: BIG_CONTRACT }),
      contract: BIG_CONTRACT,
      candidateTexts: [''],
      messages: [],
    });

  it('必填全收：契约返回几项就问几项，一个不少', () => {
    const result = runBig();
    expect(result.template.missingFields).toHaveLength(BIG_CONTRACT.length);
    expect(result.template.requiredFields).toHaveLength(BIG_CONTRACT.length);
  });

  it('顺序：身份核 → 带筛选条件的 → 纯登记项', () => {
    const result = runBig();
    expect(result.template.displayOrder).toEqual([
      // 身份核（契约原序内稳定）
      '姓名',
      '手机号',
      '年龄',
      // 带筛的
      '能做多久',
      '有无本地健康证',
      // 纯登记项
      '具体住址',
      '预计在岗多久',
    ]);
  });

  it('筛选项识别按契约本身判，不猜', () => {
    const result = runBig();
    // 年龄带 valueSpec 区间 → 带筛；具体住址无 rejected 无 valueSpec → 纯登记。
    expect(result.template.screeningFields).toEqual(['年龄', '能做多久', '有无本地健康证']);
  });

  it('降级起手字段 = 身份核 + 带筛的，绝不是随机几个登记项', () => {
    const result = runBig();
    expect(result.template.starterFields).toEqual([
      '姓名',
      '手机号',
      '年龄',
      '能做多久',
      '有无本地健康证',
    ]);
    expect(result.template.starterFields).not.toContain('具体住址');
  });

  it('模板行顺序与 displayOrder 一致（候选人看到的就是这个次序）', () => {
    const lines = runBig()
      .template.templateText.split('\n')
      .slice(1)
      // 剥掉枚举提示只留标签本体（选项型会渲染成「能做多久（半年以上/3个月内）：」）。
      .map((line) => line.split('：')[0].replace(/（[^）]*）$/u, ''));
    expect(lines).toEqual([
      '姓名',
      '手机号',
      '年龄',
      '能做多久',
      '有无本地健康证',
      '具体住址',
      '预计在岗多久',
    ]);
  });
});
