import { catalogByLayer, GUARDRAIL_CATALOG } from '@agent/guardrail/catalog';

describe('guardrail catalog', () => {
  it('every entry declares an exogenous signal (§2.5 audit invariant)', () => {
    for (const entry of GUARDRAIL_CATALOG) {
      expect(entry.exogenousSignal.trim().length).toBeGreaterThan(0);
      expect(entry.id.trim().length).toBeGreaterThan(0);
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
});
