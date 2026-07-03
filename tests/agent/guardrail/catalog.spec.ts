import {
  catalogByLayer,
  CATALOG_EXPECTED_OUTPUT_RULE_IDS,
  CATALOG_EXPECTED_TOOL_GUARDRAIL_IDS,
  GUARDRAIL_CATALOG,
} from '@agent/guardrail/catalog';
import { OUTPUT_RULE_CATALOG } from '@agent/guardrail/output/rules/output-rule-catalog';
import { TOOL_GUARDRAIL_CATALOG } from '@agent/guardrail/tool/tool-guardrail.catalog';

describe('guardrail catalog', () => {
  it('every entry declares complete audit metadata (§2.5 audit invariant)', () => {
    for (const entry of GUARDRAIL_CATALOG) {
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(entry.stage.trim().length).toBeGreaterThan(0);
      expect(entry.action.trim().length).toBeGreaterThan(0);
      expect(entry.coverage.trim().length).toBeGreaterThan(0);
      expect(entry.priority).toMatch(/^P[0-2]$/);
      expect(entry.riskGoal.trim().length).toBeGreaterThan(0);
      expect(entry.source.trim().length).toBeGreaterThan(0);
      expect(entry.exogenousSignal.trim().length).toBeGreaterThan(0);
      expect(entry.residualRisk.trim().length).toBeGreaterThan(0);
      expect(entry.verification.trim().length).toBeGreaterThan(0);
      expect(entry.owner.trim().length).toBeGreaterThan(0);
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

  it('keeps active tool guardrails registered in the audit catalog', () => {
    const toolIds = new Set(catalogByLayer('tool').map((e) => e.id));
    for (const id of CATALOG_EXPECTED_TOOL_GUARDRAIL_IDS) {
      expect(toolIds.has(id)).toBe(true);
    }
  });

  it('keeps tool guardrail metadata aligned with the tool manifest', () => {
    const toolEntries = new Map(catalogByLayer('tool').map((entry) => [entry.id, entry]));
    for (const guardrail of TOOL_GUARDRAIL_CATALOG) {
      expect(toolEntries.get(guardrail.id)).toEqual(
        expect.objectContaining({
          action: guardrail.action,
          priority: guardrail.priority,
          riskGoal: guardrail.riskGoal,
          source: guardrail.source,
          residualRisk: guardrail.residualRisk,
          verification: guardrail.verification,
          owner: guardrail.owner,
        }),
      );
    }
  });

  it('keeps output rule ids registered in the audit catalog', () => {
    const outputIds = new Set(catalogByLayer('output').map((e) => e.id));
    for (const id of CATALOG_EXPECTED_OUTPUT_RULE_IDS) {
      expect(outputIds.has(id)).toBe(true);
    }
  });

  it('keeps output rule action and priority aligned with rule metadata', () => {
    const outputEntries = new Map(catalogByLayer('output').map((entry) => [entry.id, entry]));
    for (const rule of OUTPUT_RULE_CATALOG) {
      expect(outputEntries.get(rule.id)).toEqual(
        expect.objectContaining({
          action: rule.action,
          priority: rule.priority,
          riskGoal: rule.riskGoal,
          residualRisk: rule.residualRisk,
          verification: rule.verification,
        }),
      );
    }
  });

  it('points each deterministic output rule to a domain rule file', () => {
    const outputEntries = new Map(catalogByLayer('output').map((entry) => [entry.id, entry]));
    for (const rule of OUTPUT_RULE_CATALOG) {
      const source = outputEntries.get(rule.id)?.source ?? '';
      expect(source).toContain('agent/guardrail/output/rules/');
      expect(source).toContain('.rule.ts');
    }
  });
});
