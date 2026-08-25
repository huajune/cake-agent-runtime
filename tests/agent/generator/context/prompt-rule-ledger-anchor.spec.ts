import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = process.cwd();
const SECTIONS_ROOT = join(REPO_ROOT, 'src/agent/generator/context/sections');
const PROCEDURAL_ROOTS = [
  join(SECTIONS_ROOT, 'procedural'),
  join(REPO_ROOT, 'src/agent/generator/context/procedural'),
] as const;

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe('context section knowledge classification', () => {
  it('keeps every section source inside one of the four knowledge-type directories', () => {
    const entries = readdirSync(SECTIONS_ROOT, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([]);
    expect(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['episodic', 'procedural', 'semantic', 'working']);
  });

  it.each(PROCEDURAL_ROOTS)('%s files all carry a prompt-rule-ledger anchor', (root) => {
    const files = listFiles(root);
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
