import { createForm, proposeValue, type ContractFieldDef } from '@resolution/collection';
import {
  formLabel,
  renderCollectionTemplate,
} from '@tools/collection/collection-template.renderer';

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

    expect(result.displayOrder).toEqual(['姓名', '是否学生（不要学生及暑假工）', '具体住址']);
    expect(result.missingFields).toEqual(result.displayOrder);
    expect(result.screeningFields).toEqual(['是否学生（不要学生及暑假工）']);
    expect(result.templateText).toContain('是否学生（社会人士/学生）：');
    expect(result.templateText).not.toContain('不要学生');
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

  it('keeps dirty or long contract labels compatible with the atomic form splitter', () => {
    expect(formLabel('字段，带句读。')).toBe('字段 带句读');
    expect(formLabel('很长'.repeat(30))).toHaveLength(48);
  });
});
