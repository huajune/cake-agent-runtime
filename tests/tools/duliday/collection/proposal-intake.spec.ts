import {
  collectProposals,
  findFieldByTitle,
  findFieldForClaim,
} from '@tools/duliday/collection/proposal-intake';
import { proposeValue, type ContractFieldDef } from '@resolution/collection';
import { createForm } from '@resolution/collection';

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
const STUDENT_DIRTY: ContractFieldDef = {
  labelId: 605,
  labelTitle: '是否学生（不要学生及暑假工）',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [{ optionCode: 's2', optionLabel: '社会人士' }],
  rejectedOptions: [{ optionCode: 's1', optionLabel: '学生' }],
};

const CONTRACT = [NAME, AGE, HEALTH, STUDENT_DIRTY];

function base(overrides: Partial<Parameters<typeof collectProposals>[0]> = {}) {
  return {
    contract: CONTRACT,
    candidateTexts: [] as string[],
    messages: [] as unknown[],
    filledLabelIds: new Set<number>(),
    ...overrides,
  };
}

describe('字段定位', () => {
  it('身份四槽走 systemField，其余按标题语义族', () => {
    expect(findFieldForClaim(CONTRACT, 'name')?.labelId).toBe(769);
    expect(findFieldForClaim(CONTRACT, 'age')?.labelId).toBe(687);
    expect(findFieldForClaim(CONTRACT, 'healthCertificate')?.labelId).toBe(13);
    expect(findFieldForClaim(CONTRACT, 'phone')).toBeNull();
  });

  it('补充标签按标题定位，脏标题剥括号后仍能对上', () => {
    expect(findFieldByTitle(CONTRACT, '有无本地健康证')?.labelId).toBe(13);
    expect(findFieldByTitle(CONTRACT, '是否学生')?.labelId).toBe(605);
    expect(findFieldByTitle(CONTRACT, '不存在的标签')).toBeNull();
  });

  it('主干撞车时不猜——定位错比定位不到危险得多', () => {
    // 生产实测的两对撞车主干：体重 → {20,50}、专业 → {544,659}。
    // 当前同岗位内撞车数为 0，但那是数据碰巧安全；配到一起就必须放弃匹配。
    const collided: ContractFieldDef[] = [
      { ...STUDENT_DIRTY, labelId: 20, labelTitle: '体重（净重）' },
      { ...STUDENT_DIRTY, labelId: 50, labelTitle: '体重（kg）' },
    ];
    expect(findFieldByTitle(collided, '体重')).toBeNull();
    // 全等仍然命中——歧义只发生在剥括号那一级。
    expect(findFieldByTitle(collided, '体重（kg）')?.labelId).toBe(50);
  });
});

describe('通道 1 · 主聊模型 claims（主通道）', () => {
  it('quote 直接作 sourceText，operation=correct 折成显式改口', () => {
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
    expect(proposals[0]).toMatchObject({ labelId: 769, sourceText: '我叫兮兮', channel: 'claim' });
    expect(proposals[1].restatement).toBe(true);
  });

  it('clear 操作与空值不产提案', () => {
    const proposals = collectProposals(
      base({
        claims: [
          { field: 'name', value: null, operation: 'clear', quote: 'x' },
          { field: 'age', value: '  ', quote: 'y' },
        ],
      }),
    );
    expect(proposals).toHaveLength(0);
  });

  it('该岗不收的字段不产提案（契约没这项就是没这项）', () => {
    const proposals = collectProposals(
      base({ claims: [{ field: 'phone', value: '18271421690', quote: '我电话18271421690' }] }),
    );
    expect(proposals).toHaveLength(0);
  });
});

describe('通道 2 · 九个裸字段（出处回查）', () => {
  it('裸值能在本轮语料里回查到出处 → 带真实原话片段提案', () => {
    const text = '我今年26岁';
    const proposals = collectProposals(
      base({ legacyArgs: { age: '26' }, candidateTexts: [text], messages: [] }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ labelId: 687, value: '26', channel: 'legacy_arg' });
    expect(text).toContain(proposals[0].sourceText);
  });

  it('裸值回查不到 → 不提案（模型臆造落不了地）', () => {
    const proposals = collectProposals(
      base({ legacyArgs: { age: '35' }, candidateTexts: ['你好还招人吗'] }),
    );
    expect(proposals).toHaveLength(0);
  });

  it('裸值与回查值对不上 → 裸值丢弃，安全网捞回候选人真说的那个值', () => {
    // 模型传 45（把岗位要求当自陈了），候选人原话是 26。
    // 裸字段通道因回查不等价而不提案；轮末扫描按原话提出 26——错值落不了地，真值不丢。
    const proposals = collectProposals(
      base({ legacyArgs: { age: '45' }, candidateTexts: ['我今年26岁'] }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ labelId: 687, value: '26', channel: 'adapter_sweep' });
  });

  it('带单位的宽松等价（"26" ←→ "26岁"）照常命中', () => {
    const proposals = collectProposals(
      base({ legacyArgs: { age: '26岁' }, candidateTexts: ['我今年26岁'] }),
    );
    expect(proposals).toHaveLength(1);
  });
});

describe('通道 3 · 补充标签答案', () => {
  it('按标题定位并经适配器归一到 optionCode', () => {
    const proposals = collectProposals(
      base({
        supplementAnswers: { 有无本地健康证: '有本地有效健康证' },
        candidateTexts: ['有本地有效健康证'],
      }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ labelId: 13, channel: 'supplement_answer' });
    expect(proposals[0].optionCodes).toEqual(['1']);
  });

  it('0819 病根回归：补充标签在运输里有座位', () => {
    const proposals = collectProposals(
      base({ supplementAnswers: { 是否学生: '社会人士' }, candidateTexts: ['社会人士'] }),
    );
    expect(proposals.map((p) => p.labelId)).toContain(605);
  });
});

describe('通道 4 · 适配器轮末扫描（安全网）', () => {
  it('只扫空槽，已 filled 的不碰', () => {
    const proposals = collectProposals(
      base({ candidateTexts: ['我今年26岁'], filledLabelIds: new Set([687]) }),
    );
    expect(proposals.map((p) => p.labelId)).not.toContain(687);
  });

  it('主模型漏作证时兜底补上', () => {
    const proposals = collectProposals(base({ candidateTexts: ['我今年26岁'] }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ labelId: 687, channel: 'adapter_sweep' });
  });
});

describe('通道去重：主通道胜出', () => {
  it('同槽被 claim 与扫描同时命中 → 取 claim（主模型证词优先）', () => {
    const proposals = collectProposals(
      base({
        claims: [{ field: 'age', value: '26', quote: '我今年26岁' }],
        legacyArgs: { age: '26' },
        candidateTexts: ['我今年26岁'],
      }),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].channel).toBe('claim');
  });
});

describe('全通道产物一律过公证', () => {
  it('回查出处的裸字段提案能过公证入账', () => {
    const text = '我今年26岁';
    const [proposal] = collectProposals(
      base({
        legacyArgs: { age: '26' },
        candidateTexts: [text],
        messages: [{ role: 'user', content: text }],
      }),
    );
    const result = proposeValue(createForm({ jobId: 1, contract: CONTRACT }), AGE, proposal);
    expect(result.outcome).toBe('accepted');
  });

  it('无出处的 claim 照样被公证拒（运输不豁免公证）', () => {
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
});
