import { createForm, proposeValue, type ContractFieldDef } from '@resolution/collection';
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
    const written = proposeValue(form, CONTRACT[0], {
      value: '兮兮',
      sourceText: '我叫兮兮',
      producer: 'candidate_quote',
      candidateTexts: ['我叫兮兮'],
      messages: [{ role: 'user', content: '我叫兮兮' }],
    }).form;

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
    expect(result.displayOrder).toEqual([dirty.labelTitle]);
    expect(result.templateText).toContain(`${dirty.labelTitle}：`);
  });
});
