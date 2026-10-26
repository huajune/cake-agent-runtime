import { BUSINESS_TOPICS } from '../../../src/agent/generator/context/manual-loader';
import {
  selectRuleTests,
  validateRegistry,
  type RuleBinding,
} from '../../../scripts/business-rules/registry';

function fixture() {
  const files = new Map<string, string>([
    ['src/consumer.ts', '// business-rules: IB-01\nexport const booking = true;'],
    ['tests/consumer.spec.ts', 'it("checks consumer behavior", () => {});'],
  ]);
  for (const topic of BUSINESS_TOPICS) {
    files.set(
      `docs/business-rules/${topic.toLowerCase()}.md`,
      `# Topic
## ${topic}-01 Existing policy
- 状态：现行基线
- 来源：existing decision
- 落点：\`src/consumer.ts#booking\`
- 验证：\`tests/consumer.spec.ts\`
`,
    );
  }
  return files;
}

const binding: RuleBinding = {
  id: 'booking',
  businessRule: 'IB-01',
  catalog: 'src/consumer.ts',
  anchor: 'booking',
};

describe('business rule registry integrity', () => {
  it('resolves the seven topics and deduplicates their test selection', () => {
    const { rules, errors } = validateRegistry(fixture(), [binding]);
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(7);
    expect(selectRuleTests(rules, ['IB', 'SW'])).toEqual(['tests/consumer.spec.ts']);
    expect(() => selectRuleTests(rules, ['XX'])).toThrow('Unknown topic');
  });

  it('detects deleted tests and renamed implementation anchors', () => {
    const files = fixture();
    files.delete('tests/consumer.spec.ts');
    files.set('src/consumer.ts', '// business-rules: IB-01\nexport const renamed = true;');
    const { errors } = validateRegistry(files, [binding]);
    expect(errors.some((error) => error.includes('Missing reference'))).toBe(true);
    expect(errors.some((error) => error.includes('Missing anchor'))).toBe(true);
  });

  it('rejects unresolved policies wired into runtime and unknown catalog IDs', () => {
    const files = fixture();
    const path = 'docs/business-rules/ib.md';
    files.set(path, files.get(path)!.replace('现行基线', '待裁定'));
    const { errors } = validateRegistry(files, [binding, { ...binding, businessRule: 'IB-99' }]);
    expect(errors.some((error) => error.includes('Inactive rule used at runtime'))).toBe(true);
    expect(errors.some((error) => error.includes('Unknown business rule'))).toBe(true);
  });

  it('requires reverse links for both source comments and concrete catalog entries', () => {
    const files = fixture();
    files.set('src/second.ts', '// business-rules: IB-01');
    const { errors } = validateRegistry(files, [{ ...binding, anchor: 'unlisted' }]);
    expect(errors.some((error) => error.includes('Missing reverse implementation link'))).toBe(
      true,
    );
    expect(errors.some((error) => error.includes('Missing reverse catalog link'))).toBe(true);
  });

  it('allows protocol mechanisms only with an explicit rationale', () => {
    const mechanism = { ...binding, businessRule: null };
    expect(validateRegistry(fixture(), [mechanism]).errors).toContain(
      'Mechanism needs rationale: booking',
    );
    expect(
      validateRegistry(fixture(), [{ ...mechanism, mechanismReason: 'Protocol shape only' }])
        .errors,
    ).toEqual([]);
  });

  it('rejects missing topics, duplicate IDs and references escaping the repository', () => {
    const files = fixture();
    files.delete('docs/business-rules/sw.md');
    const path = 'docs/business-rules/ib.md';
    files.set(
      path,
      files.get(path)! + files.get(path)!.replace('src/consumer.ts', 'src/../../secret'),
    );
    const { errors } = validateRegistry(files, []);
    expect(errors.some((error) => error.includes('Missing topic'))).toBe(true);
    expect(errors.some((error) => error.includes('Duplicate rule'))).toBe(true);
    expect(errors.some((error) => error.includes('Unsafe reference'))).toBe(true);
  });
});
