const { validateConfig } = jest.requireActual<{
  validateConfig(config: unknown): { ok: boolean; issues: string[] };
}>('../../scripts/check-hosting-member-config-drift.js');

describe('hosting config integrity check', () => {
  it('accepts database-owned identities and intentional empty operations recipients', () => {
    expect(
      validateConfig({
        members: { henan: { feishuOpenId: 'ou_henan', feishuName: '河南成员' } },
        operationsReceivers: [],
        taskOwners: {},
      }).ok,
    ).toBe(true);
  });
  it('rejects missing migration or broken entries without disclosing tokens', () => {
    const result = validateConfig({ members: { henan: { dulidayToken: 'private-value' } } });
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
});
export {};
