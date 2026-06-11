import {
  extractHighConfidenceFacts,
  unwrapHighConfidenceFacts,
} from '@memory/facts/high-confidence-facts';
import { EXTRACTION_BADCASES } from './extraction-badcases.fixture';

const BRANDS = [
  { name: '肯德基', aliases: ['KFC'] },
  { name: '来伊份', aliases: ['来一份'] },
];

function readPath(values: Record<string, unknown> | null, path: string): unknown {
  if (!values) return null;
  const [group, field] = path.split('.');
  const groupValue = values[group] as Record<string, unknown> | undefined;
  return groupValue?.[field] ?? null;
}

describe('规则提取误捕回归集（data-driven）', () => {
  for (const fixture of EXTRACTION_BADCASES) {
    it(fixture.description, () => {
      const result = extractHighConfidenceFacts([fixture.input], BRANDS as never);
      const values = result
        ? (unwrapHighConfidenceFacts(result) as unknown as Record<string, unknown> | null)
        : null;

      for (const [path, expected] of Object.entries(fixture.shouldExtract ?? {})) {
        expect({ path, value: readPath(values, path) }).toEqual({ path, value: expected });
      }
      for (const path of fixture.shouldNotExtract ?? []) {
        expect({ path, value: readPath(values, path) }).toEqual({ path, value: null });
      }
    });
  }
});
