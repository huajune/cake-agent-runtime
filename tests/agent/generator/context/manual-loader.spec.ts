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
  it('preserves every model-visible byte from the pre-refactor manual', async () => {
    const text = await loadCandidateManual(
      join(process.cwd(), 'src/agent/generator/context/sections/procedural'),
    );
    // Migration evidence from 12090e6f, before any includes existed. Deliberate policy
    // changes must explain a new baseline and add behavioral evidence in the same PR.
    expect(Buffer.byteLength(text)).toBe(55988);
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      'f2e59fec2118593b57fd82244c01f22a51b3f2219e07c903f163bc7f8c7f3b44',
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
