import { createForm, proposeValue, type ContractFieldDef } from '@resolution/collection';
import { FormAnswerInputSchema } from '@tools/collection/form-answer-input';
import {
  collectProposals,
  findFieldByTitle,
  findFieldForClaim,
  resolveFieldByTitle,
} from '@tools/collection/proposal-intake';

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
  rejectedOptions: [],
};
const STUDENT: ContractFieldDef = {
  labelId: 605,
  labelTitle: '是否学生（不要学生及暑假工）',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [{ optionCode: 's2', optionLabel: '社会人士' }],
  rejectedOptions: [{ optionCode: 's1', optionLabel: '学生' }],
};
const RESUME: ContractFieldDef = {
  labelId: 900,
  labelTitle: '简历附件',
  fieldType: 'FILE',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
};
const CONTRACT = [NAME, AGE, HEALTH, STUDENT, RESUME];

function base(overrides: Partial<Parameters<typeof collectProposals>[0]> = {}) {
  return {
    contract: CONTRACT,
    candidateTexts: [] as string[],
    messages: [] as unknown[],
    filledLabelIds: new Set<number>(),
    ...overrides,
  };
}

describe('FormAnswerInputSchema', () => {
  it('只收统一数组项协议，不收 boolean', () => {
    expect(
      FormAnswerInputSchema.safeParse({ labelTitle: '年龄', value: false, quote: '不是学生' })
        .success,
    ).toBe(false);
    expect(
      FormAnswerInputSchema.safeParse({ labelTitle: '年龄', value: '26', quote: '我26岁' }).success,
    ).toBe(true);
  });

  it('clear 必须 value=null 且带 quote；对类确认在值来自问句时必须绑定问句', () => {
    expect(
      FormAnswerInputSchema.safeParse({
        labelTitle: '年龄',
        value: null,
        operation: 'clear',
        quote: '年龄先清掉',
      }).success,
    ).toBe(true);
    expect(
      FormAnswerInputSchema.safeParse({
        labelTitle: '年龄',
        value: '25',
        operation: 'confirm',
        quote: '对',
      }).success,
    ).toBe(false);
  });
});

describe('proposal intake（统一 formAnswers 运输）', () => {
  it('档案语义字段仍只映射当岗契约已有槽位，不臆造字段', () => {
    expect(findFieldForClaim(CONTRACT, 'name')?.labelId).toBe(769);
    expect(findFieldForClaim(CONTRACT, 'phone')).toBeNull();
  });

  it('标题按 NFKC + 双侧剥括号主干容错，主干撞车时弃权', () => {
    expect(findFieldByTitle(CONTRACT, '是否学生')?.labelId).toBe(605);
    expect(findFieldByTitle(CONTRACT, '是否学生（请填写）')?.labelId).toBe(605);
    const collided = [
      { ...STUDENT, labelId: 20, labelTitle: '体重（净重）' },
      { ...STUDENT, labelId: 50, labelTitle: '体重（kg）' },
    ];
    expect(resolveFieldByTitle(collided, '体重')).toEqual({
      field: null,
      reason: 'label_title_ambiguous',
    });
  });

  it('标准语义字段与动态字段都从 formAnswers 携带 value + quote，correct 标为改口', () => {
    const proposals = collectProposals(
      base({
        formAnswers: [
          { labelTitle: '姓名', value: '兮兮', quote: '我叫兮兮' },
          { labelTitle: '年龄', value: 26, quote: '我26岁', operation: 'correct' },
          { labelTitle: '有无本地健康证', value: '有本地有效健康证', quote: '我有本地有效健康证' },
        ],
        candidateTexts: ['我叫兮兮，我26岁，我有本地有效健康证'],
      }),
    );
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labelId: 769, channel: 'form_answer', sourceText: '我叫兮兮' }),
        expect.objectContaining({ labelId: 687, value: '26', restatement: true }),
        expect.objectContaining({ labelId: 13, optionCodes: ['1'] }),
      ]),
    );
  });

  it('clear 不生成值提案；证据不存在时拒收原因进入既有审计面', () => {
    const audits: Array<{ reason: string }> = [];
    expect(
      collectProposals(
        base({
          formAnswers: [
            { labelTitle: '年龄', value: null, quote: '年龄先清掉', operation: 'clear' },
          ],
          candidateTexts: ['没有说过这句'],
          onAudit: (audit) => audits.push(audit),
        }),
      ),
    ).toEqual([]);
    expect(audits).toContainEqual(expect.objectContaining({ reason: 'source_text_not_found' }));
  });

  it('契约外标题与主干撞车都不生成槽位并产生定位审计', () => {
    const audits: Array<{ reason: string }> = [];
    const collided = [
      { ...STUDENT, labelId: 20, labelTitle: '体重（净重）' },
      { ...STUDENT, labelId: 50, labelTitle: '体重（kg）' },
    ];
    const proposals = collectProposals({
      ...base(),
      contract: collided,
      formAnswers: [
        { labelTitle: '身份', value: '社会人士', quote: '我是社会人士' },
        { labelTitle: '体重', value: '60', quote: '我60公斤' },
      ],
      onAudit: (audit) => audits.push(audit),
    });
    expect(proposals).toEqual([]);
    expect(audits.map((audit) => audit.reason)).toEqual([
      'label_title_not_found',
      'label_title_ambiguous',
    ]);
  });

  it('候选人逐行回填时只把冒号右侧交给适配器，未删占位提示则跳过', () => {
    const [proposal] = collectProposals(
      base({ candidateTexts: ['是否学生（不要学生及暑假工）：社会人士'] }),
    );
    expect(proposal).toMatchObject({
      labelId: 605,
      value: '社会人士',
      optionCodes: ['s2'],
      channel: 'form_line',
    });
    expect(
      collectProposals(
        base({
          candidateTexts: ['有无本地健康证：（有本地有效健康证/无本地有效健康证，接受办理）'],
        }),
      ),
    ).toEqual([]);
  });

  it('主模型漏作证时确定性扫描只补 empty 槽；同槽命中时 formAnswers 胜出', () => {
    expect(collectProposals(base({ candidateTexts: ['我今年26岁'] }))).toEqual([
      expect.objectContaining({ labelId: 687, value: '26', channel: 'adapter_sweep' }),
    ]);
    const proposals = collectProposals(
      base({
        formAnswers: [{ labelTitle: '年龄', value: '26', quote: '我今年26岁' }],
        candidateTexts: ['我今年26岁'],
      }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].channel).toBe('form_answer');
  });

  it('统一入口不豁免公证：quote 不在候选人原文时拒收', () => {
    const [proposal] = collectProposals(
      base({
        formAnswers: [{ labelTitle: '年龄', value: '35', quote: '我35岁' }],
        candidateTexts: ['你好'],
        messages: [{ role: 'user', content: '你好' }],
      }),
    );
    const result = proposeValue(createForm({ jobId: 1, contract: CONTRACT }), AGE, proposal);
    expect(result.outcome).toBe('rejected');
  });

  it('确认式答案显式携带真实 Agent 问句并复用既有确认公证', () => {
    const question = '年龄是25，对吗？';
    const messages = [
      { role: 'assistant', content: question },
      { role: 'user', content: '对' },
    ];
    const [proposal] = collectProposals(
      base({
        formAnswers: [
          {
            labelTitle: '年龄',
            value: '25',
            quote: '对',
            operation: 'confirm',
            agentQuestionQuote: question,
          },
        ],
        candidateTexts: ['对'],
        messages,
      }),
    );
    expect(proposal.agentQuestionQuote).toBe(question);
    const result = proposeValue(createForm({ jobId: 1, contract: CONTRACT }), AGE, proposal);
    expect(result.outcome).toBe('accepted');
  });

  it('FILE 字段用候选人消息中的真实附件 URL 作证', () => {
    const url = 'https://cdn.example.com/resume.pdf';
    const [proposal] = collectProposals(
      base({
        formAnswers: [{ labelTitle: '简历附件', value: url }],
        candidateTexts: [`简历附件：${url}`],
      }),
    );
    const result = proposeValue(createForm({ jobId: 1, contract: CONTRACT }), RESUME, proposal);
    expect(result.outcome).toBe('accepted');
    expect(result.form.slots[900].value?.value).toBe(url);
  });

  it('任意 MULTIPLE_OPTION 动态标签可用多个契约 optionLabel 统一提交', () => {
    const shifts: ContractFieldDef = {
      labelId: 901,
      labelTitle: '意向班次',
      fieldType: 'MULTIPLE_OPTION',
      required: true,
      acceptedOptions: [
        { optionCode: 'm', optionLabel: '早班' },
        { optionCode: 'e', optionLabel: '晚班' },
      ],
      rejectedOptions: [],
    };
    const [proposal] = collectProposals({
      ...base(),
      contract: [shifts],
      formAnswers: [{ labelTitle: '意向班次', value: '早班、晚班', quote: '早晚班都可以' }],
      candidateTexts: ['早晚班都可以'],
    });
    expect(proposal).toMatchObject({
      value: '早班、晚班',
      optionCodes: ['m', 'e'],
      channel: 'form_answer',
    });
    expect(
      proposeValue(createForm({ jobId: 1, contract: [shifts] }), shifts, proposal).outcome,
    ).toBe('accepted');
  });
});
