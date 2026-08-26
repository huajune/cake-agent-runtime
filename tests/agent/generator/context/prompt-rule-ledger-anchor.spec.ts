import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { OUTPUT_RULE_IDS } from '@agent/guardrail/output/rules/output-rule-catalog';
import { FINAL_CHECK_RULES } from '@agent/generator/context/sections/procedural/final-check.section';

const REPO_ROOT = process.cwd();
const SECTIONS_ROOT = join(REPO_ROOT, 'src/agent/generator/context/sections');
const PROCEDURAL_ROOT = join(SECTIONS_ROOT, 'procedural');
const LEDGER_PATH = join(REPO_ROOT, 'docs/prompt-rule-ledger.md');

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe('context section knowledge classification', () => {
  it('keeps sections in the three populated knowledge directories and infrastructure at root', () => {
    const entries = readdirSync(SECTIONS_ROOT, { withFileTypes: true });
    expect(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['section.interface.ts', 'static.section.ts']);
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

  it('indexes every code-owned prompt and output guard rule id', () => {
    const ledger = readFileSync(LEDGER_PATH, 'utf8');
    const expectedRuleIds = new Set([
      ...FINAL_CHECK_RULES.map((rule) => rule.id),
      ...OUTPUT_RULE_IDS,
    ]);

    for (const ruleId of expectedRuleIds) {
      expect({ ruleId, indexed: ledger.includes(`\`${ruleId}\``) }).toEqual({
        ruleId,
        indexed: true,
      });
    }
  });
});
