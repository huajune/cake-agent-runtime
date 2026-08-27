import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERDICT_SITE_AUTHORITIES, VERDICT_SITE_REGISTRY } from '@resolution/verdict-site.registry';

describe('VERDICT_SITE_REGISTRY', () => {
  const expectedSiteIds = [
    'candidate_claim_quote_provenance',
    'candidate_claim_value_shape',
    'candidate_claim_quote_context',
    'candidate_claim_agent_echo',
    'candidate_claim_same_value_merge',
    'candidate_claim_conflict_route',
    'candidate_profile_clear_projection',
    'booking_candidate_name_provenance',
    'booking_candidate_phone_provenance',
    'job_list_job_id_provenance',
    'precheck_job_id_provenance',
    'booking_job_id_provenance',
    'precheck_required_field_difference',
    'candidate_rule_fact_prompt_hint',
    'candidate_profile_prefill_hint',
  ] as const;

  it('registers every known reject, supersede, missing-field and hint site exactly once', () => {
    const ids = VERDICT_SITE_REGISTRY.map((site) => site.id);
    expect(ids).toEqual(expect.arrayContaining(expectedSiteIds));
    expect(ids).toHaveLength(expectedSiteIds.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('admits only the four P11 authority classes and no semantic verdict class', () => {
    expect(VERDICT_SITE_AUTHORITIES).toEqual(['structural_gate', 'closed_form', 'notary', 'hint']);
    for (const site of VERDICT_SITE_REGISTRY) {
      expect(VERDICT_SITE_AUTHORITIES).toContain(site.authority);
      expect(site.authority).not.toBe('semantic_verdict');
      expect(site.rationale.trim()).not.toBe('');
    }
  });

  it('keeps every registered source anchored to a real repository file', () => {
    for (const site of VERDICT_SITE_REGISTRY) {
      const [sourceFile, symbol] = site.source.split('#');
      expect(symbol).toBeTruthy();
      expect(existsSync(resolve(process.cwd(), sourceFile))).toBe(true);
    }
  });
});
