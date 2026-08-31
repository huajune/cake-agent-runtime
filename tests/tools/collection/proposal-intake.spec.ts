import { createForm, applyFieldValueProposal, type ContractFieldDef } from '@resolution/collection';
import { FieldValueProposalInputSchema } from '@tools/collection/field-value-proposal-input';
import {
  collectFieldValueProposals,
  findFieldByTitle,
  findFieldForCandidateFact,
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
const PHONE: ContractFieldDef = {
  labelId: 770,
  labelTitle: '手机号',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'phone',
};
const CONTRACT = [NAME, AGE, HEALTH, STUDENT, RESUME];
const PHONE_CONTRACT = [NAME, AGE, PHONE, HEALTH, STUDENT];

function base(overrides: Partial<Parameters<typeof collectFieldValueProposals>[0]> = {}) {
  return {
    contract: CONTRACT,
    candidateTexts: [] as string[],
    filledLabelIds: new Set<number>(),
    ...overrides,
  };
}

describe('FieldValueProposalInputSchema', () => {
  it('只收统一数组项协议，不收 boolean', () => {
    expect(
      FieldValueProposalInputSchema.safeParse({ labelTitle: '年龄', value: false, quote: '不是学生' })
        .success,
    ).toBe(false);
    expect(
      FieldValueProposalInputSchema.safeParse({ labelTitle: '年龄', value: '26', quote: '我26岁' }).success,
    ).toBe(true);
  });

  it('clear 必须 value=null 且带 quote；对类确认在值来自问句时必须绑定问句', () => {
    expect(
      FieldValueProposalInputSchema.safeParse({
        labelTitle: '年龄',
        value: null,
        operation: 'clear',
        quote: '年龄先清掉',
      }).success,
    ).toBe(true);
    expect(
      FieldValueProposalInputSchema.safeParse({
        labelTitle: '年龄',
        value: '25',
        operation: 'confirm',
        quote: '对',
      }).success,
    ).toBe(false);
  });
});

describe('proposal intake（统一 fieldValueProposals 运输）', () => {
  it('档案语义字段仍只映射当岗契约已有槽位，不臆造字段', () => {
    expect(findFieldForCandidateFact(CONTRACT, 'name')?.labelId).toBe(769);
    expect(findFieldForCandidateFact(CONTRACT, 'phone')).toBeNull();
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

  it('标准语义字段与动态字段都从 fieldValueProposals 携带 value + quote，correct 标为改口', () => {
    const proposals = collectFieldValueProposals(
      base({
        fieldValueProposals: [
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
      collectFieldValueProposals(
        base({
          fieldValueProposals: [
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
    const proposals = collectFieldValueProposals({
      ...base(),
      contract: collided,
      fieldValueProposals: [
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

  it('第三级身份同义词回退：「联系方式」「联系电话」定位 phone 槽并可入槽（0826 生产回放最大失配类）', () => {
    expect(findFieldByTitle(PHONE_CONTRACT, '联系方式')?.labelId).toBe(770);
    expect(findFieldByTitle(PHONE_CONTRACT, '联系电话')?.labelId).toBe(770);

    const quote = '我的手机号是18271421690';
    const [proposal] = collectFieldValueProposals(
      base({
        contract: PHONE_CONTRACT,
        fieldValueProposals: [{ labelTitle: '联系方式', value: '18271421690', quote }],
        candidateTexts: [quote],
      }),
    );
    expect(proposal).toMatchObject({ labelId: 770, value: '18271421690', channel: 'form_answer' });
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract: PHONE_CONTRACT }),
      PHONE,
      proposal,
      { candidateTexts: [quote], messages: [{ role: 'user', content: quote }] },
    );
    expect(result.outcome).toBe('accepted');
    expect(result.form.slots[770].value?.value).toBe('18271421690');
  });

  it('第三级判定顺序：原文全匹配先行，「联系电话（本人）」由剥括号主干救回', () => {
    // 原文「联系电话（本人）」对身份词表全匹配不中（正则 ^…$），剥主干得「联系电话」后命中 phone。
    expect(findFieldByTitle(PHONE_CONTRACT, '联系电话（本人）')?.labelId).toBe(770);
    // 包含式不触发：「电话费报销」含「电话」但非全匹配，主干亦然 → 弃权不猜。
    expect(resolveFieldByTitle(PHONE_CONTRACT, '电话费报销')).toEqual({
      field: null,
      reason: 'label_title_not_found',
    });
  });

  it('第三级封闭四槽：契约无 phone systemField 槽时弃权并落定位审计，不臆造字段', () => {
    const audits: Array<{ reason: string }> = [];
    expect(
      collectFieldValueProposals(
        base({
          fieldValueProposals: [
            { labelTitle: '联系方式', value: '18271421690', quote: '我的手机号是18271421690' },
          ],
          candidateTexts: ['我的手机号是18271421690'],
          onAudit: (audit) => audits.push(audit),
        }),
      ),
    ).toEqual([]);
    expect(audits).toContainEqual(expect.objectContaining({ reason: 'label_title_not_found' }));
  });

  it('第三级同 systemField 多槽（契约异常态）与动态标签同名时的优先级', () => {
    // 同 systemField 出现两槽 → 弃权不猜，与主干撞车同款处置。
    const doubled = [PHONE, { ...PHONE, labelId: 771, labelTitle: '手机号码' }];
    expect(resolveFieldByTitle(doubled, '联系方式')).toEqual({
      field: null,
      reason: 'label_title_ambiguous',
    });
    // 契约恰有名为「联系方式」的动态标签时，第一级全等先命中它——第三级只兜前两级全灭的场景。
    const dynamicContact: ContractFieldDef = {
      labelId: 888,
      labelTitle: '联系方式',
      fieldType: 'TEXT',
      required: true,
      acceptedOptions: [],
      rejectedOptions: [],
    };
    expect(findFieldByTitle([...PHONE_CONTRACT, dynamicContact], '联系方式')?.labelId).toBe(888);
  });

  it('候选人逐行回填时只把冒号右侧交给适配器，未删占位提示则跳过', () => {
    const [proposal] = collectFieldValueProposals(
      base({ candidateTexts: ['是否学生（不要学生及暑假工）：社会人士'] }),
    );
    expect(proposal).toMatchObject({
      labelId: 605,
      value: '社会人士',
      optionCodes: ['s2'],
      channel: 'form_line',
    });
    expect(
      collectFieldValueProposals(
        base({
          candidateTexts: ['有无本地健康证：（有本地有效健康证/无本地有效健康证，接受办理）'],
        }),
      ),
    ).toEqual([]);
    // FILE 字段的发文件占位同样是模板噪音，回抄不算作答。
    expect(
      collectFieldValueProposals(
        base({ candidateTexts: ['简历附件：（直接发文件或截图，不用打字填写）'] }),
      ),
    ).toEqual([]);
  });

  it('主模型漏作证时确定性扫描只补 empty 槽；同槽命中时 fieldValueProposals 胜出', () => {
    expect(collectFieldValueProposals(base({ candidateTexts: ['我今年26岁'] }))).toEqual([
      expect.objectContaining({ labelId: 687, value: '26', channel: 'adapter_sweep' }),
    ]);
    const proposals = collectFieldValueProposals(
      base({
        fieldValueProposals: [{ labelTitle: '年龄', value: '26', quote: '我今年26岁' }],
        candidateTexts: ['我今年26岁'],
      }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].channel).toBe('form_answer');
  });

  it('统一入口不豁免公证：quote 不在候选人原文时拒收', () => {
    const [proposal] = collectFieldValueProposals(
      base({
        fieldValueProposals: [{ labelTitle: '年龄', value: '35', quote: '我35岁' }],
        candidateTexts: ['你好'],
      }),
    );
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract: CONTRACT }),
      AGE,
      proposal,
      { candidateTexts: ['你好'], messages: [{ role: 'user', content: '你好' }] },
    );
    expect(result.outcome).toBe('rejected');
  });

  it('确认式答案显式携带真实 Agent 问句并复用既有确认公证', () => {
    const question = '年龄是25，对吗？';
    const messages = [
      { role: 'assistant', content: question },
      { role: 'user', content: '对' },
    ];
    const [proposal] = collectFieldValueProposals(
      base({
        fieldValueProposals: [
          {
            labelTitle: '年龄',
            value: '25',
            quote: '对',
            operation: 'confirm',
            agentQuestionQuote: question,
          },
        ],
        candidateTexts: ['对'],
      }),
    );
    expect(proposal.agentQuestionQuote).toBe(question);
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract: CONTRACT }),
      AGE,
      proposal,
      { candidateTexts: ['对'], messages },
    );
    expect(result.outcome).toBe('accepted');
  });

  it('FILE 字段用候选人消息中的真实附件 URL 作证', () => {
    const url = 'https://cdn.example.com/resume.pdf';
    const [proposal] = collectFieldValueProposals(
      base({
        fieldValueProposals: [{ labelTitle: '简历附件', value: url }],
        candidateTexts: [`简历附件：${url}`],
      }),
    );
    const result = applyFieldValueProposal(
      createForm({ jobId: 1, contract: CONTRACT }),
      RESUME,
      proposal,
      { candidateTexts: [`简历附件：${url}`], messages: [] },
    );
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
    const [proposal] = collectFieldValueProposals({
      ...base(),
      contract: [shifts],
      fieldValueProposals: [{ labelTitle: '意向班次', value: '早班、晚班', quote: '早晚班都可以' }],
      candidateTexts: ['早晚班都可以'],
    });
    expect(proposal).toMatchObject({
      value: '早班、晚班',
      optionCodes: ['m', 'e'],
      channel: 'form_answer',
    });
    expect(
      applyFieldValueProposal(
        createForm({ jobId: 1, contract: [shifts] }),
        shifts,
        proposal,
        { candidateTexts: ['早晚班都可以'], messages: [] },
      ).outcome,
    ).toBe('accepted');
  });
});
