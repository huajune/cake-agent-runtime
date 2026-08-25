import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = process.cwd();
const SECTIONS_ROOT = join(REPO_ROOT, 'src/agent/generator/context/sections');
const PROCEDURAL_ROOT = join(SECTIONS_ROOT, 'procedural');

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe('context section knowledge classification', () => {
  it('keeps sections in the three populated knowledge directories and infrastructure at root', () => {
    const entries = readdirSync(SECTIONS_ROOT, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([
      'section.interface.ts',
    ]);
    expect(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['procedural', 'semantic', 'working']);
  });

  it('keeps every procedural .ts/.md file anchored to the prompt rule ledger', () => {
    const files = listFiles(PROCEDURAL_ROOT).filter(
      (file) => file.endsWith('.ts') || file.endsWith('.md'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({
        file: relative(REPO_ROOT, file),
        hasLedgerAnchor: readFileSync(file, 'utf8').includes('prompt-rule-ledger'),
      }).toEqual({
        file: relative(REPO_ROOT, file),
        hasLedgerAnchor: true,
      });
    }
  });
});
