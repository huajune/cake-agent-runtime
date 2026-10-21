import { BUILT_IN_TOOL_CONTRACTS, validateToolContract } from '@tools/tool-contracts';
import { TOOL_GUARDRAIL_CATALOG } from '@agent/guardrail/tool/tool-guardrail.catalog';
import {
  SIDE_EFFECT_TOOLS,
  REPLAY_BLOCKING_TOOLS,
  findToolsExceedingLimit,
} from '@agent/generator/tool-call-analysis';

describe('tool action contracts', () => {
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
