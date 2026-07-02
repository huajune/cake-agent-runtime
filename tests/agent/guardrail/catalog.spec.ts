import { catalogByLayer, GUARDRAIL_CATALOG } from '@agent/guardrail/catalog';
import { OUTPUT_RULE_CATALOG } from '@agent/guardrail/output/rules/output-rule-catalog';
import { TOOL_GUARDRAIL_CATALOG } from '@agent/guardrail/tool/tool-guardrail.catalog';

describe('guardrail catalog', () => {
  it('every entry declares an exogenous signal (§2.5 audit invariant)', () => {
    for (const entry of GUARDRAIL_CATALOG) {
      expect(entry.exogenousSignal.trim().length).toBeGreaterThan(0);
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.source.trim().length).toBeGreaterThan(0);
    }
  });

  it('ids are unique', () => {
    const ids = GUARDRAIL_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all three layers', () => {
    expect(catalogByLayer('input').length).toBeGreaterThan(0);
    expect(catalogByLayer('tool').length).toBeGreaterThan(0);
    expect(catalogByLayer('output').length).toBeGreaterThan(0);
  });

  it('registers the landed HC-2/3 tool guardrails', () => {
    const ids = new Set(GUARDRAIL_CATALOG.map((e) => e.id));
    expect(ids.has('booking_jobid_provenance')).toBe(true);
    expect(ids.has('booking_name_authority')).toBe(true);
  });

  it('derives output rule entries from the output rule catalog', () => {
    const outputIds = new Set(catalogByLayer('output').map((e) => e.id));
    for (const rule of OUTPUT_RULE_CATALOG) {
      expect(outputIds.has(rule.id)).toBe(true);
      expect(rule.description.trim().length).toBeGreaterThan(0);
      expect(rule.description).not.toBe(rule.riskGoal);
    }
  });

  it('derives tool entries from the tool guardrail catalog', () => {
    const toolIds = new Set(catalogByLayer('tool').map((e) => e.id));
    for (const entry of TOOL_GUARDRAIL_CATALOG) {
      expect(toolIds.has(entry.id)).toBe(true);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.description).not.toBe(entry.riskGoal);
    }
  });

  it('does not point output entries at the legacy rule-guardrail service', () => {
    for (const entry of catalogByLayer('output')) {
      expect(entry.source).not.toContain('rule-guardrail.service.ts');
    }
  });
});
