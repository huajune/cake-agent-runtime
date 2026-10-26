import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GUARDRAIL_CATALOG } from '../../src/agent/guardrail/catalog';
import { FINAL_CHECK_RULES } from '../../src/agent/generator/context/sections/procedural/final-check.section';
import { loadCandidateManual } from '../../src/agent/generator/context/manual-loader';
import { validateRegistry, type RuleBinding } from './registry';

function readSources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(ts|md)$/.test(entry.name)) {
        files.set(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8'));
      }
    }
  };
  for (const directory of ['src', 'tests', 'docs/business-rules']) visit(join(root, directory));
  return files;
}

export async function checkBusinessRules(root = process.cwd()) {
  const catalogs = {
    input: 'src/agent/guardrail/input/input-rule-catalog.ts',
    tool: 'src/agent/guardrail/tool/tool-guardrail.catalog.ts',
    output: 'src/agent/guardrail/output/output-rule-catalog.ts',
  };
  const bindings: RuleBinding[] = [
    ...GUARDRAIL_CATALOG.map((rule) => ({
      ...rule,
      catalog: catalogs[rule.layer],
      anchor: rule.layer === 'input' ? 'defineInputRiskRule' : rule.id,
    })),
    ...FINAL_CHECK_RULES.map((rule) => ({
      ...rule,
      catalog: 'src/agent/generator/context/sections/procedural/final-check.section.ts',
      anchor: rule.id,
    })),
  ];
  const result = validateRegistry(readSources(root), bindings);
  try {
    await loadCandidateManual(join(root, 'src/agent/generator/context/sections/procedural'));
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return result.rules;
}
