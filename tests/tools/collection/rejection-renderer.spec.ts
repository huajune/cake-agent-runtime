import { createForm, type ContractFieldDef } from '@resolution/collection/form.types';
import { applyFieldValueProposal } from '@resolution/collection/form-writes';
import { renderRejection } from '@tools/collection/rejection-renderer';

const GENDER_MALE_ONLY: ContractFieldDef = {
  labelId: 771,
  labelTitle: '性别',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [{ optionCode: '1', optionLabel: '男' }],
  rejectedOptions: [{ optionCode: '2', optionLabel: '女' }],
  systemField: 'gender',
};

const AGE_18_40: ContractFieldDef = {
  labelId: 687,
  labelTitle: '年龄',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  systemField: 'age',
  valueSpec: { kind: 'number', min: 18, max: 40, unit: '岁', genderRanges: [] },
};

/** 禁明说族：守卫红线属性（基线实测籍贯(3)、专业×2(544/659) 实存）。 */
const HOMETOWN_FIELD: ContractFieldDef = {
  labelId: 3,
  labelTitle: '籍贯',
  fieldType: 'SINGLE_OPTION',
  required: true,
  acceptedOptions: [{ optionCode: 'a', optionLabel: '本省' }],
  rejectedOptions: [{ optionCode: 'b', optionLabel: '外省' }],
};

/** 分性别值域（实测 528995 身高）。 */
const HEIGHT_GENDERED: ContractFieldDef = {
  labelId: 4,
  labelTitle: '身高(cm)',
  fieldType: 'TEXT',
  required: true,
  acceptedOptions: [],
  rejectedOptions: [],
  valueSpec: {
    kind: 'number',
    min: null,
    max: null,
    unit: 'cm',
    genderRanges: [
      { gender: 'MALE', min: 160, max: 190 },
      { gender: 'FEMALE', min: 150, max: 180 },
    ],
  },
};

const CONTRACT = [GENDER_MALE_ONLY, AGE_18_40, HOMETOWN_FIELD];

function disqualify(field: ContractFieldDef, value: string, optionCodes?: string[]) {
  const form = createForm({ jobId: 1, contract: CONTRACT });
  const sourceText = `我是${value}`;
  const result = applyFieldValueProposal(form, field, {
    value,
    optionCodes,
    sourceText,
    producer: 'candidate_quote',
  }, { candidateTexts: [sourceText], messages: [] });
  expect(result.outcome).toBe('disqualified');
  return result.form;
}

describe('renderRejection · 可明说族', () => {
  it('性别：直说要求 + 转岗（快照）', () => {
    const script = renderRejection({
      form: disqualify(GENDER_MALE_ONLY, '女', ['2']),
      contract: CONTRACT,
    });
    expect(script?.disclosureLevel).toBe('open');
    expect(script?.candidateMessage).toMatchInlineSnapshot(
      `"这个岗位「性别」要求是男，你这边暂时对不上，我再帮你看看其他岗位"`,
    );
  });

  it('年龄：要求描述只用契约的 min/max 造句，不外推', () => {
    const form = createForm({ jobId: 1, contract: CONTRACT });
    const sourceText = '我今年55岁';
    const disqualified = applyFieldValueProposal(form, AGE_18_40, {
      value: '55',
      sourceText,
      producer: 'candidate_quote',
    }, { candidateTexts: [sourceText], messages: [] }).form;
    const script = renderRejection({ form: disqualified, contract: CONTRACT });
    expect(script?.candidateMessage).toContain('年龄要求 18-40岁');
  });

  it('分性别值域按候选人性别取那一档造句——说错档等于报错要求', () => {
    const contract = [GENDER_MALE_ONLY, HEIGHT_GENDERED];
    let form = createForm({ jobId: 1, contract });
    form = applyFieldValueProposal(form, GENDER_MALE_ONLY, {
      value: '男',
      optionCodes: ['1'],
      sourceText: '我是男的',
      producer: 'candidate_quote',
    }, { candidateTexts: ['我是男的'], messages: [] }).form;
    const disqualified = applyFieldValueProposal(form, HEIGHT_GENDERED, {
      value: '150',
      sourceText: '我150',
      producer: 'candidate_quote',
    }, { candidateTexts: ['我150'], messages: [] });
    expect(disqualified.outcome).toBe('disqualified');
    const script = renderRejection({ form: disqualified.form, contract });
    // 男档 160-190，不能说成女档的 150-180
    expect(script?.candidateMessage).toContain('身高要求 160-190cm');
  });

  it('账本真实原因不进话术，只进 internalReason', () => {
    const script = renderRejection({
      form: disqualify(GENDER_MALE_ONLY, '女', ['2']),
      contract: CONTRACT,
    });
    expect(script?.internalReason).toContain('labelId=771');
    expect(script?.internalReason).toContain('候选人答「女」');
    expect(script?.candidateMessage).not.toContain('labelId');
  });

  it('可明说族不受因果隔离影响（岗位卡本来就写着要求）', () => {
    const script = renderRejection({
      form: disqualify(GENDER_MALE_ONLY, '女', ['2']),
      contract: CONTRACT,
      fieldsAnsweredThisTurn: [GENDER_MALE_ONLY],
    });
    expect(script?.deferred).toBe(false);
    expect(script?.candidateMessage).not.toBeNull();
  });
});

describe('renderRejection · 禁明说族', () => {
  const restricted = () => disqualify(HOMETOWN_FIELD, '外省', ['b']);

  it('绝不披露真实原因：话术不点名字段、不复述候选人答案（快照）', () => {
    const script = renderRejection({ form: restricted(), contract: CONTRACT });
    expect(script?.disclosureLevel).toBe('restricted');
    expect(script?.candidateMessage).toMatchInlineSnapshot(
      `"这家的岗位跟你这边暂时没太对上，我再帮你找找其他合适的，有匹配的第一时间告诉你"`,
    );
    for (const leak of ['籍贯', '外省', '本省', 'labelId']) {
      expect(script?.candidateMessage).not.toContain(leak);
    }
  });

  it('账本照样落真实原因（判定入账永远如实）', () => {
    const script = renderRejection({ form: restricted(), contract: CONTRACT });
    expect(script?.internalReason).toContain('籍贯');
    expect(script?.internalReason).toContain('外省');
  });

  it('因果隔离：本轮刚答过禁明说字段 → 本轮不拒，话术为 null', () => {
    const script = renderRejection({
      form: restricted(),
      contract: CONTRACT,
      fieldsAnsweredThisTurn: [HOMETOWN_FIELD],
    });
    expect(script?.deferred).toBe(true);
    expect(script?.candidateMessage).toBeNull();
  });

  it('禁令清单点名"不得暗示因为刚说的那个"', () => {
    const script = renderRejection({ form: restricted(), contract: CONTRACT });
    expect(script?.forbiddenActions.join('')).toContain('不得暗示');
    expect(script?.forbiddenActions.join('')).toContain('绝不披露真实不合格原因');
  });

  it('未知新标签默认走禁明说档', () => {
    const unknownField: ContractFieldDef = {
      labelId: 9999,
      labelTitle: '是否有纹身',
      fieldType: 'SINGLE_OPTION',
      required: true,
      acceptedOptions: [{ optionCode: 'n', optionLabel: '无' }],
      rejectedOptions: [{ optionCode: 'y', optionLabel: '有' }],
    };
    const contract = [unknownField];
    const sourceText = '我有的';
    const form = applyFieldValueProposal(createForm({ jobId: 1, contract }), unknownField, {
      value: '有',
      optionCodes: ['y'],
      sourceText,
      producer: 'candidate_quote',
    }, { candidateTexts: [sourceText], messages: [] }).form;
    expect(renderRejection({ form, contract })?.disclosureLevel).toBe('restricted');
  });
});

describe('renderRejection · 边界', () => {
  it('非 disqualified 的表单不产拒绝话术', () => {
    expect(
      renderRejection({ form: createForm({ jobId: 1, contract: CONTRACT }), contract: CONTRACT }),
    ).toBeNull();
  });
});
