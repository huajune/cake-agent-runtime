import {
  BUILT_IN_TOOL_CONTRACTS,
  validateToolContract,
  publishToolContract,
  getToolContract,
} from '@tools/tool-contracts';
import { TOOL_GUARDRAIL_CATALOG } from '@agent/guardrail/tool/tool-guardrail.catalog';
import {
  SIDE_EFFECT_TOOLS,
  REPLAY_BLOCKING_TOOLS,
  findToolsExceedingLimit,
} from '@agent/generator/tool-call-analysis';
import type { ToolActionContract, ToolGate } from '@shared-types/tool-action.contract';

describe('tool action contracts', () => {
  it.each([
    { effect: 'external_actoin' },
    { replay: 'always_retry' },
    { freshness: 'latest' },
    { maxCallsPerTurn: 0 },
    { maxCallsPerTurn: 1.5 },
    { gates: ['booking_precheck_contrcat'] },
    { gates: [1] },
    { idempotency: undefined },
    { idempotency: null },
    { idempotency: {} },
    { idempotency: { scope: 'global', target: ['jobId'] } },
    { idempotency: { scope: 'business', target: [] } },
    { idempotency: { scope: 'business', target: [' '] } },
    { idempotency: { scope: 'business', target: [123] } },
  ])('rejects malformed runtime policy before publication: %j', (overrides) => {
    const name = 'invalid_runtime_contract';
    const input = { ...BUILT_IN_TOOL_CONTRACTS.duliday_interview_booking, ...overrides };
    expect(() => validateToolContract(input)).toThrow(
      'A complete tool action contract is required',
    );
    expect(() => publishToolContract(name, input as ToolActionContract)).toThrow();
    expect(getToolContract(name)).toBeUndefined();
  });

  it('accepts existing serialized contracts without rewriting protocol values', () => {
    const wireContract: unknown = JSON.parse(
      JSON.stringify({
        effect: 'external_action',
        replay: 'block_on_success',
        freshness: 'latest_input',
        maxCallsPerTurn: 3,
        gates: ['booking_precheck_contract'],
        idempotency: { scope: 'business', target: ['candidatePhone', 'jobId'] },
      }),
    );
    const before = JSON.stringify(wireContract);
    validateToolContract(wireContract);
    expect(wireContract.effect).toBe('external_action');
    expect(JSON.stringify(wireContract)).toBe(before);
  });

  it('rejects misspelled gate IDs at the TypeScript boundary', () => {
    // @ts-expect-error Gate IDs must come from the shared closed vocabulary.
    const invalid: ToolGate = 'booking_precheck_contrcat';
    expect(() =>
      validateToolContract({ ...BUILT_IN_TOOL_CONTRACTS.advance_stage, gates: [invalid] }),
    ).toThrow();
  });

  it('keeps the approved side-effect and replay policies in the contracts', () => {
    expect([...SIDE_EFFECT_TOOLS].sort()).toEqual([
      'duliday_cancel_work_order',
      'duliday_interview_booking',
      'duliday_modify_interview_time',
      'invite_to_group',
      'raise_risk_alert',
      'request_handoff',
      'send_store_location',
    ]);
    expect([...REPLAY_BLOCKING_TOOLS].sort()).toEqual([
      'duliday_cancel_work_order',
      'duliday_interview_booking',
      'duliday_modify_interview_time',
      'invite_to_group',
      'send_store_location',
    ]);
  });

  it('enforces each declared limit without a tool-name special case', () => {
    expect(
      findToolsExceedingLimit([
        {
          toolCalls: [
            { toolName: 'duliday_interview_precheck' },
            { toolName: 'duliday_interview_precheck' },
            { toolName: 'duliday_interview_precheck' },
            { toolName: 'duliday_job_list' },
            { toolName: 'duliday_job_list' },
          ],
        },
      ]),
    ).toEqual(['duliday_interview_precheck']);
  });

  it('requires complete declarations and bidirectional gate ownership', () => {
    const contracts: Readonly<Record<string, (typeof BUILT_IN_TOOL_CONTRACTS)['advance_stage']>> =
      BUILT_IN_TOOL_CONTRACTS;
    for (const [name, contract] of Object.entries(contracts)) {
      expect(() => validateToolContract(contract)).not.toThrow();
      for (const gate of contract.gates) {
        const entry = TOOL_GUARDRAIL_CATALOG.find((value) => value.id === gate);
        expect(entry?.toolNames).toContain(name);
      }
    }
    for (const gate of TOOL_GUARDRAIL_CATALOG) {
      for (const name of gate.toolNames) expect(contracts[name]?.gates).toContain(gate.id);
    }
  });
});
