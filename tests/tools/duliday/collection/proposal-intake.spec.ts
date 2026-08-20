import { createForm, proposeValue, type ContractFieldDef } from '@resolution/collection';
import {
  collectProposals,
  findFieldByTitle,
  findFieldForClaim,
} from '@tools/duliday/collection/proposal-intake';

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
const CONTRACT = [NAME, AGE, HEALTH, STUDENT];

function base(overrides: Partial<Parameters<typeof collectProposals>[0]> = {}) {
  return {
    contract: CONTRACT,
    candidateTexts: [] as string[],
    messages: [] as unknown[],
    filledLabelIds: new Set<number>(),
    ...overrides,
  };
}

describe('proposal intake（表单终态运输）', () => {
  it('身份字段只按 systemField 映射，契约没带就不臆造槽位', () => {
    expect(findFieldForClaim(CONTRACT, 'name')?.labelId).toBe(769);
    expect(findFieldForClaim(CONTRACT, 'phone')).toBeNull();
  });

  it('动态字段按实时标题映射，括号主干撞车时不猜', () => {
    expect(findFieldByTitle(CONTRACT, '是否学生')?.labelId).toBe(605);
    const collided = [
      { ...STUDENT, labelId: 20, labelTitle: '体重（净重）' },
      { ...STUDENT, labelId: 50, labelTitle: '体重（kg）' },
    ];
    expect(findFieldByTitle(collided, '体重')).toBeNull();
  });

  it('candidateClaims 直接携带逐字 quote，correct 标为本人改口', () => {
    const proposals = collectProposals(
      base({
        claims: [
          { field: 'name', value: '兮兮', quote: '我叫兮兮' },
          { field: 'age', value: '26', quote: '我26岁', operation: 'correct' },
        ],
        candidateTexts: ['我叫兮兮，我26岁'],
      }),
    );
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ labelId: 769, channel: 'claim' });
    expect(proposals[1]).toMatchObject({ labelId: 687, restatement: true });
  });

  it('clear 与空值不生成写入提案', () => {
    expect(
      collectProposals(
        base({
          claims: [
            { field: 'name', value: null, quote: '别用之前的名字', operation: 'clear' },
            { field: 'age', value: ' ', quote: '年龄先不填' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('选项 claim 经契约适配器生成 optionCodes', () => {
    const [proposal] = collectProposals(
      base({
        claims: [
          { field: 'healthCertificate', value: '有本地有效健康证', quote: '我有本地有效健康证' },
        ],
        candidateTexts: ['我有本地有效健康证'],
      }),
    );
    expect(proposal).toMatchObject({ labelId: 13, optionCodes: ['1'], channel: 'claim' });
  });

  it('formAnswers 为动态字段生成 labelId + optionCodes，不再走 supplement family', () => {
    const proposals = collectProposals(
      base({
        formAnswers: {
          有无本地健康证: '有本地有效健康证',
          是否学生: '社会人士',
        },
        candidateTexts: ['我有本地有效健康证，身份是社会人士'],
      }),
    );
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labelId: 13, optionCodes: ['1'], channel: 'form_answer' }),
        expect.objectContaining({ labelId: 605, optionCodes: ['s2'], channel: 'form_answer' }),
      ]),
    );
  });

  it('候选人逐行回填表单时只把冒号右侧交给适配器', () => {
    const [proposal] = collectProposals(
      base({ candidateTexts: ['是否学生（不要学生及暑假工）：社会人士'] }),
    );
    expect(proposal).toMatchObject({
      labelId: 605,
      value: '社会人士',
      optionCodes: ['s2'],
      channel: 'form_line',
    });
  });

  it('主模型漏作证时确定性扫描只补 empty 槽', () => {
    const proposals = collectProposals(base({ candidateTexts: ['我今年26岁'] }));
    expect(proposals).toEqual([
      expect.objectContaining({ labelId: 687, value: '26', channel: 'adapter_sweep' }),
    ]);
    expect(
      collectProposals(base({ candidateTexts: ['我今年26岁'], filledLabelIds: new Set([687]) })),
    ).toEqual([]);
  });

  it('同槽多通道命中时 claims 胜出', () => {
    const proposals = collectProposals(
      base({
        claims: [{ field: 'age', value: '26', quote: '我今年26岁' }],
        candidateTexts: ['我今年26岁'],
      }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].channel).toBe('claim');
  });

  it('运输通道不豁免公证：quote 不在候选人原文时拒收', () => {
    const [proposal] = collectProposals(
      base({
        claims: [{ field: 'age', value: '35', quote: '我35岁' }],
        candidateTexts: ['你好'],
        messages: [{ role: 'user', content: '你好' }],
      }),
    );
    const result = proposeValue(createForm({ jobId: 1, contract: CONTRACT }), AGE, proposal);
    expect(result.outcome).toBe('rejected');
  });

  it('确认式 claim 显式携带 agentQuestionQuote', () => {
    const [proposal] = collectProposals(
      base({
        claims: [
          {
            field: 'age',
            value: '25',
            quote: '对',
            operation: 'confirm',
            agentQuestionQuote: '年龄是25，对吗？',
          },
        ],
        candidateTexts: ['对'],
      }),
    );
    expect(proposal.agentQuestionQuote).toBe('年龄是25，对吗？');
    const result = proposeValue(createForm({ jobId: 1, contract: CONTRACT }), AGE, proposal);
    expect(result.outcome).toBe('accepted');
  });
});
