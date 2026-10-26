import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleManual } from '@agent/generator/context/manual-loader';

/** Inspect the same assembled instructions used by ContextService, not the include manifest. */
export function readCandidateManual(root = process.cwd()): string {
  const base = join(root, 'src/agent/generator/context/sections/procedural');
  return assembleManual(readFileSync(join(base, 'candidate-consultation.md'), 'utf8'), (topic) =>
    readFileSync(join(base, 'rules', `${topic.toLowerCase()}.md`), 'utf8'),
  );
}
