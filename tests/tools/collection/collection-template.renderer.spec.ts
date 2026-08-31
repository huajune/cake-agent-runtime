import { createForm, applyFieldValueProposal, type ContractFieldDef } from '@resolution/collection';
import { renderCollectionTemplate } from '@tools/collection/collection-template.renderer';

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
    const written = applyFieldValueProposal(form, CONTRACT[0], {
      value: '兮兮',
      sourceText: '我叫兮兮',
      producer: 'candidate_quote',
    }, { candidateTexts: ['我叫兮兮'], messages: [{ role: 'user', content: '我叫兮兮' }] }).form;

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
    const blank = renderCollectionTemplate(
      createForm({ jobId: 529091, contract: [RESUME_FILE] }),
      [RESUME_FILE],
    );
    expect(blank.templateText).toContain('上传简历：（直接发文件或截图，不用打字填写）');

    // 拒收重问档同样保留提示（FILE 无枚举可强制，提示不分档）。
    const attempted = createForm({ jobId: 529091, contract: [RESUME_FILE] });
    attempted.slots[49].rejectedAttempts = 1;
    const forced = renderCollectionTemplate(attempted, [RESUME_FILE]);
    expect(forced.templateText).toContain('上传简历：（直接发文件或截图，不用打字填写）');
  });
});
