import { createForm, applyFieldValueProposal, type ContractFieldDef } from '@resolution/collection';
import { renderCollectionTemplate } from '@tools/collection/collection-template.renderer';
import { collectFieldValueProposals } from '@tools/collection/proposal-intake';
import {
  DURATION_FIELD,
  AVAILABILITY_FIELD,
  WEEKEND_FIELD,
} from '../../helpers/work-condition.fixture';

const CONTRACT: ContractFieldDef[] = [
  {
    labelId: 101,
    labelTitle: '姓名',
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
    systemField: 'name',
  },
  {
    labelId: 102,
    labelTitle: '是否学生（不要学生及暑假工）',
    fieldType: 'SINGLE_OPTION',
    required: true,
    acceptedOptions: [{ optionCode: 'social', optionLabel: '社会人士' }],
    rejectedOptions: [{ optionCode: 'student', optionLabel: '学生' }],
  },
  {
    labelId: 103,
    labelTitle: '具体住址',
    fieldType: 'TEXT',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
  },
];

describe('renderCollectionTemplate', () => {
  it('renders identity, screening, then registration fields from one live contract', () => {
    const form = createForm({ jobId: 528962, contract: CONTRACT });
    const result = renderCollectionTemplate(form, CONTRACT);

    expect(result.missingFields).toEqual(['姓名', '是否学生（不要学生及暑假工）', '具体住址']);
    expect(result.requiredFields).toEqual(result.missingFields);
    expect(result.screeningFields).toEqual(['是否学生（不要学生及暑假工）']);
    expect(result.templateText).toContain('是否学生（不要学生及暑假工）：（社会人士/学生）');
  });

  it('prefills a notarized value and never reports the filled slot as missing', () => {
    const form = createForm({ jobId: 528962, contract: CONTRACT });
    const written = applyFieldValueProposal(
      form,
      CONTRACT[0],
      {
        value: '兮兮',
        sourceText: '我叫兮兮',
        producer: 'candidate_quote',
      },
      { candidateTexts: ['我叫兮兮'], messages: [{ role: 'user', content: '我叫兮兮' }] },
    ).form;

    const result = renderCollectionTemplate(written, CONTRACT);
    expect(result.knownFieldMap).toEqual({ 姓名: '兮兮' });
    expect(result.missingFields).not.toContain('姓名');
    expect(result.templateText).toContain('姓名：兮兮');
  });

  it('templateText 行标签与清单逐字使用契约 labelTitle，不清洗脏标题或截断长标题', () => {
    const dirty = {
      ...CONTRACT[2],
      labelId: 104,
      labelTitle: `字段，带句读。${'很长'.repeat(30)}`,
    };
    const result = renderCollectionTemplate(createForm({ jobId: 1, contract: [dirty] }), [dirty]);
    expect(result.requiredFields).toEqual([dirty.labelTitle]);
    expect(result.templateText).toContain(`${dirty.labelTitle}：`);
  });
});

describe('拒收重问档 · 强制枚举占位', () => {
  const SOCIAL: ContractFieldDef = {
    labelId: 12,
    labelTitle: '社保缴纳情况',
    fieldType: 'SINGLE_OPTION',
    required: true,
    acceptedOptions: [
      { optionCode: '1', optionLabel: '本人缴纳本地社保' },
      { optionCode: '2', optionLabel: '无公司在缴社保流水' },
    ],
    rejectedOptions: [
      { optionCode: '3', optionLabel: '公司缴纳本地社保' },
      { optionCode: '4', optionLabel: '本人缴纳外地社保' },
      { optionCode: '5', optionLabel: '公司缴纳外地社保' },
    ],
  };

  it('选项 >4 普通档留空；该槽位有 rejectedAttempts 后强制列全（badcase 6a8fec04）', () => {
    const blank = renderCollectionTemplate(createForm({ jobId: 1, contract: [SOCIAL] }), [SOCIAL]);
    expect(blank.templateText.endsWith('社保缴纳情况：')).toBe(true);

    const attempted = createForm({ jobId: 1, contract: [SOCIAL] });
    attempted.slots[12].rejectedAttempts = 1;
    const forced = renderCollectionTemplate(attempted, [SOCIAL]);
    expect(forced.templateText).toContain(
      '社保缴纳情况：（本人缴纳本地社保/无公司在缴社保流水/公司缴纳本地社保/本人缴纳外地社保/公司缴纳外地社保）',
    );
  });
});

describe('单个可选项 · 告知选项但不擅自增加门槛（2026-11-04 用户裁定）', () => {
  const WORK_WINDOW: ContractFieldDef = {
    labelId: 741,
    labelTitle: '每天可工作时间段',
    fieldType: 'MULTIPLE_OPTION',
    required: true,
    acceptedOptions: [{ optionCode: '1', optionLabel: '09:30-22:30' }],
    rejectedOptions: [],
  };

  it('首问展示唯一合法选项和真实回答出口，不把选项个数当筛选依据', () => {
    const result = renderCollectionTemplate(createForm({ jobId: 1, contract: [WORK_WINDOW] }), [
      WORK_WINDOW,
    ]);
    expect(result.templateText).toContain(
      '每天可工作时间段：（可选项：09:30-22:30；请按实际情况填写，不符合请直接说明）',
    );
    expect(result.screeningFields).toEqual([]);
    expect(result.publicRequirements).toEqual([]);
    expect(result.templateText).not.toContain('内都能排班');
  });

  it('重问档同一句；非时间形态的条件用通用措辞', () => {
    const attempted = createForm({ jobId: 1, contract: [WORK_WINDOW] });
    attempted.slots[741].rejectedAttempts = 1;
    expect(renderCollectionTemplate(attempted, [WORK_WINDOW]).templateText).toContain(
      '每天可工作时间段：（可选项：09:30-22:30；请按实际情况填写，不符合请直接说明）',
    );

    const relocate: ContractFieldDef = {
      ...WORK_WINDOW,
      labelId: 628,
      labelTitle: '是否接受一定范围内门店调度',
      fieldType: 'SINGLE_OPTION',
      acceptedOptions: [{ optionCode: '1', optionLabel: '接受调度' }],
    };
    expect(
      renderCollectionTemplate(createForm({ jobId: 1, contract: [relocate] }), [relocate])
        .templateText,
    ).toContain(
      '是否接受一定范围内门店调度：（可选项：接受调度；请按实际情况填写，不符合请直接说明）',
    );
  });

  it('敏感属性 / 契约明标 RESTRICTED 的单选项仍留空——条件即筛选条件，不能用提示泄露', () => {
    const hometown: ContractFieldDef = {
      ...WORK_WINDOW,
      labelId: 3,
      labelTitle: '籍贯',
      fieldType: 'SINGLE_OPTION',
      acceptedOptions: [{ optionCode: '1', optionLabel: '上海市' }],
    };
    expect(
      renderCollectionTemplate(createForm({ jobId: 1, contract: [hometown] }), [
        hometown,
      ]).templateText.endsWith('籍贯：'),
    ).toBe(true);
    const marked: ContractFieldDef = { ...WORK_WINDOW, disclosure: 'RESTRICTED' };
    expect(
      renderCollectionTemplate(createForm({ jobId: 1, contract: [marked] }), [
        marked,
      ]).templateText.endsWith('每天可工作时间段：'),
    ).toBe(true);
  });
});

describe('公开工期、班次要求与真实回答分别呈现', () => {
  it('badcase 459023：先告知可接受工期，同时保留两个不合格答案', () => {
    const contract = [DURATION_FIELD, WEEKEND_FIELD, AVAILABILITY_FIELD];
    const result = renderCollectionTemplate(createForm({ jobId: 529230, contract }), contract);
    expect(result.publicRequirements).toEqual([
      '要求做到年后：可以做到年后 / 可以做6个月以上',
      '周末两天是否在岗：周末两天都在接受门店排班',
    ]);
    expect(result.templateText.indexOf('• 要求做到年后')).toBeLessThan(
      result.templateText.indexOf('先将以下资料'),
    );
    expect(result.templateText).toContain('不符合上述要求也请如实回答');
    expect(result.templateText).toContain(
      '要求做到年后：（可以做到年后/可以做6个月以上/只能做0-3个月/可以做3-6个月）',
    );
    expect(result.templateText).toContain('每天可工作时间段：（07:00-16:00/16:00-23:00）');
    expect(result.screeningFields).not.toContain(AVAILABILITY_FIELD.labelTitle);
  });

  it('无拒绝项的普通工期选择题不增加报名门槛', () => {
    const field = {
      ...DURATION_FIELD,
      acceptedOptions: [...DURATION_FIELD.acceptedOptions, ...DURATION_FIELD.rejectedOptions],
      rejectedOptions: [],
    };
    const result = renderCollectionTemplate(createForm({ jobId: 1, contract: [field] }), [field]);
    expect(result.publicRequirements).toEqual([]);
    expect(result.screeningFields).toEqual([]);
    expect(result.templateText).not.toContain('这个岗位的报名要求');
    expect(result.templateText).toContain('只能做0-3个月');
  });

  it('整张未填写模板的回显不会把公开要求或预印选项写成候选人的答案', () => {
    const contract = [DURATION_FIELD, WEEKEND_FIELD, AVAILABILITY_FIELD];
    const text = renderCollectionTemplate(
      createForm({ jobId: 529230, contract }),
      contract,
    ).templateText;
    expect(
      collectFieldValueProposals({ contract, candidateTexts: [text], filledLabelIds: new Set() }),
    ).toEqual([]);
  });

  it.each([
    { ...DURATION_FIELD, disclosure: 'RESTRICTED' as const },
    { ...DURATION_FIELD, labelTitle: '籍贯与工期' },
    { ...DURATION_FIELD, labelInstructions: '专业要求：餐饮相关专业' },
  ])('敏感属性或显式受限仍不泄露可接受集合：$labelTitle', (field) => {
    const result = renderCollectionTemplate(createForm({ jobId: 1, contract: [field] }), [field]);
    expect(result.publicRequirements).toEqual([]);
    expect(result.templateText).not.toContain('这个岗位的报名要求');
  });

  it('工期数值门槛使用配置的上下界和单位', () => {
    const field: ContractFieldDef = {
      ...DURATION_FIELD,
      labelTitle: '预计在岗月数',
      fieldType: 'TEXT',
      acceptedOptions: [],
      rejectedOptions: [],
      valueSpec: { kind: 'number', min: 3, unit: '个月', genderRanges: [] },
    };
    expect(
      renderCollectionTemplate(createForm({ jobId: 1, contract: [field] }), [field])
        .publicRequirements,
    ).toEqual(['预计在岗月数：3个月以上']);
  });
});

describe('FILE 字段 · 发文件占位提示（生产 chat 6a9117face406a6aee7f99c9）', () => {
  const RESUME_FILE: ContractFieldDef = {
    labelId: 49,
    labelTitle: '上传简历',
    fieldType: 'FILE',
    required: true,
    acceptedOptions: [],
    rejectedOptions: [],
  };

  it('FILE 字段常驻「发文件别打字」提示——空行会邀请候选人打字，文字永远过不了形态门', () => {
    const blank = renderCollectionTemplate(createForm({ jobId: 529091, contract: [RESUME_FILE] }), [
      RESUME_FILE,
    ]);
    expect(blank.templateText).toContain('上传简历：（直接发文件或截图，不用打字填写）');

    // 拒收重问档同样保留提示（FILE 无枚举可强制，提示不分档）。
    const attempted = createForm({ jobId: 529091, contract: [RESUME_FILE] });
    attempted.slots[49].rejectedAttempts = 1;
    const forced = renderCollectionTemplate(attempted, [RESUME_FILE]);
    expect(forced.templateText).toContain('上传简历：（直接发文件或截图，不用打字填写）');
  });
});
