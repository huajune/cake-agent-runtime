import { existsSync } from 'fs';
import { resolve } from 'path';
import { catalogByLayer, GUARDRAIL_CATALOG } from '@agent/guardrail/catalog';
import { OUTPUT_RULE_CATALOG } from '@agent/guardrail/output/output-rule-catalog';

describe('guardrail aggregate catalog', () => {
  it('every entry declares complete audit metadata', () => {
    for (const entry of GUARDRAIL_CATALOG) {
      for (const key of [
        'id',
        'layer',
        'stage',
        'action',
        'coverage',
        'description',
        'riskGoal',
        'source',
        'exogenousSignal',
        'residualRisk',
        'verification',
        'owner',
      ] as const) {
        expect(entry[key].trim().length).toBeGreaterThan(0);
      }
      expect(entry.priority).toMatch(/^P[0-2]$/);
      expect(['active', 'planned']).toContain(entry.status);
      if (entry.layer !== 'tool') expect(entry.entrypoint?.trim()).toBeTruthy();
    }
  });

  it('ids are globally unique', () => {
    const ids = GUARDRAIL_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registers only Input, Tool and Output rules at their execution stages', () => {
    expect([...new Set(GUARDRAIL_CATALOG.map((entry) => entry.layer))].sort()).toEqual([
      'input',
      'output',
      'tool',
    ]);
    const stages = { input: 'input_pre_agent', tool: 'tool_runtime', output: 'output_pre_send' };
    for (const entry of GUARDRAIL_CATALOG) expect(entry.stage).toBe(stages[entry.layer]);
  });

  it('references existing implementation and verification files', () => {
    // Tool gates can cite multiple files plus a Chinese entrypoint annotation.
    // Validate actual files, not an expected-ID list derived from the same catalog.
    for (const entry of GUARDRAIL_CATALOG) {
      const sources = entry.source.match(/[a-zA-Z0-9_./-]+\.ts\b/g) ?? [];
      const tests = entry.verification.match(/tests\/[a-zA-Z0-9_./-]+\.spec\.ts\b/g) ?? [];
      expect(sources.length).toBeGreaterThan(0);
      expect(tests.length).toBeGreaterThan(0);
      for (const source of sources) expect(existsSync(resolve('src', source))).toBe(true);
      for (const test of tests) expect(existsSync(resolve(test))).toBe(true);
    }
  });

  it('projects Output metadata without a second action/source map', () => {
    const entries = catalogByLayer('output');
    expect(entries).toHaveLength(OUTPUT_RULE_CATALOG.length);
    for (const rule of OUTPUT_RULE_CATALOG) {
      expect(entries.find((entry) => entry.id === rule.id)).toEqual(
        expect.objectContaining({
          action: rule.action,
          priority: rule.priority,
          source: rule.source,
          entrypoint: rule.entrypoint,
          description: rule.description,
          riskGoal: rule.riskGoal,
          exogenousSignal: rule.exogenousSignal,
        }),
      );
    }
  });

  it('does not turn repair into a tool whitelist or introduce new replan rules', () => {
    for (const rule of OUTPUT_RULE_CATALOG) expect(rule.repairToolNames).toEqual([]);
    expect(
      OUTPUT_RULE_CATALOG.filter((rule) => rule.action === 'replan')
        .map((rule) => rule.id)
        .sort(),
    ).toEqual(['job_fact_without_provenance', 'job_query_claim_without_query']);
  });
});
