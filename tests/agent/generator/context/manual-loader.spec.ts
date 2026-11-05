import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleManual,
  loadCandidateManual,
  parseRuleFragments,
} from '@agent/generator/context/manual-loader';

const fragment = (id: string, body = 'rule text') =>
  `<!-- rule:${id} -->\n${body}\n<!-- end-rule:${id} -->`;

describe('business rule manual assembly', () => {
  it('preserves the approved model-visible manual snapshot', async () => {
    const text = await loadCandidateManual(
      join(process.cwd(), 'src/agent/generator/context/sections/procedural'),
    );
    // Original migration baseline: 12090e6f (55,988 bytes; hash recorded in prompt-rule-ledger).
    // 2026-11-04 user-approved SW-02 change separates insuranceFundList / haveInsurance /
    // socialSecurityList. Behavioral coverage: insurance-fields.render + welfare-facts tests.
    expect(Buffer.byteLength(text)).toBe(56794);
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      'fd8b1e8764e4a6d6e3221192ec748956781cd856f2a58ea4580c0a77d7a81f38',
    );
    expect(text).not.toContain('{{rule:');
    expect(text).not.toContain('<!--');
  });

  it('keeps manifest order and whitespace while stripping maintainer information', () => {
    expect(
      assembleManual('before\n{{rule:IB-02}}\n{{rule:IB-01}}\nafter', () =>
        [fragment('IB-01', 'first <!-- private -->'), fragment('IB-02', 'second')].join('\n'),
      ),
    ).toBe('before\nsecond\nfirst\nafter');
  });

  it('rejects missing, duplicate, malformed and nested inclusions', () => {
    expect(() => assembleManual('{{rule:IB-02}}', () => fragment('IB-01'))).toThrow('Missing');
    expect(() => assembleManual('{{rule:IB-01}}{{rule:IB-01}}', () => fragment('IB-01'))).toThrow(
      'Duplicate',
    );
    expect(() => assembleManual('{{rule:../secret}}', () => '')).toThrow('Malformed');
    expect(() =>
      assembleManual('{{rule:IB-01}}', () => fragment('IB-01', '{{rule:IB-02}}')),
    ).toThrow('nested');
    expect(() => parseRuleFragments(fragment('IB-01') + fragment('IB-01'))).toThrow('Duplicate');
    expect(() => parseRuleFragments('<!-- rule:IB-01 -->\nunclosed')).toThrow('Malformed');
    expect(() => parseRuleFragments('unmarked instruction\n' + fragment('IB-01'))).toThrow(
      'outside',
    );
    expect(() => parseRuleFragments(fragment('IB-01', '<!-- comment only -->'))).toThrow('Empty');
    expect(() => parseRuleFragments(fragment('IB-01', fragment('IB-02')))).toThrow('Nested');
    expect(() =>
      assembleManual('{{rule:IB-01}}', () => fragment('IB-01') + fragment('IB-02')),
    ).toThrow('Unreferenced');
  });

  it('fails closed if packaged topic assets are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cake-rule-assets-'));
    try {
      await mkdir(join(root, 'rules'));
      await writeFile(join(root, 'candidate-consultation.md'), '{{rule:IB-01}}');
      await expect(loadCandidateManual(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
