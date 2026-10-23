import { RUNTIME_RETRY_LIMITS } from '@infra/config/constants/runtime-retry.constants';
import type { ToolActionContract } from '@shared-types/tool-action.contract';

export const DEFAULT_TOOL_CALL_LIMIT = RUNTIME_RETRY_LIMITS.sameToolCalls;

function contract(
  effect: ToolActionContract['effect'],
  options: Partial<Omit<ToolActionContract, 'effect'>> = {},
): ToolActionContract {
  return Object.freeze({
    effect,
    replay: 'allow',
    freshness: 'none',
    maxCallsPerTurn: DEFAULT_TOOL_CALL_LIMIT,
    gates: [],
    idempotency: null,
    ...options,
  });
}

/** Single declaration used by registration, replay and per-turn limits. No model schema changes. */
export const BUILT_IN_TOOL_CONTRACTS = {
  advance_stage: contract('local_state'),
  recall_history: contract('readonly'),
  duliday_job_list: contract('readonly', {
    gates: ['job_list_brand_provenance', 'job_list_schedule_constraint_provenance'],
  }),
  duliday_interview_precheck: contract('local_state', {
    maxCallsPerTurn: RUNTIME_RETRY_LIMITS.precheckCalls,
    gates: ['booking_jobid_provenance'],
  }),
  duliday_interview_booking: contract('external_action', {
    replay: 'block_on_success',
    freshness: 'latest_input',
    gates: [
      'booking_jobid_provenance',
      'booking_precheck_contract',
      'booking_real_name',
      'booking_name_authority',
    ],
    idempotency: { scope: 'business', target: ['candidatePhone', 'jobId'] },
  }),
  duliday_cancel_work_order: contract('external_action', {
    replay: 'block_on_success',
    gates: ['cancel_work_order_ownership'],
    idempotency: { scope: 'business', target: ['workOrderId'] },
  }),
  duliday_modify_interview_time: contract('external_action', {
    replay: 'block_on_success',
    gates: ['modify_work_order_ownership'],
    idempotency: { scope: 'business', target: ['workOrderId', 'interviewTime'] },
  }),
  geocode: contract('readonly', { gates: ['invite_city_provenance'] }),
  send_store_location: contract('external_action', {
    replay: 'block_on_success',
    idempotency: { scope: 'turn', target: ['storeId'] },
  }),
  invite_to_group: contract('external_action', {
    replay: 'block_on_success',
    gates: ['invite_city_provenance', 'invite_timing_gate'],
    idempotency: { scope: 'business', target: ['chatId', 'groupId'] },
  }),
  raise_risk_alert: contract('intervention_intent'),
  request_handoff: contract('intervention_intent'),
  skip_reply: contract('local_state'),
  save_image_description: contract('local_state', { gates: ['image_message_allowlist'] }),
  read_resume_attachment: contract('local_state'),
} as const satisfies Record<string, ToolActionContract>;

export function getBuiltInToolContract(name: string): ToolActionContract | undefined {
  return (BUILT_IN_TOOL_CONTRACTS as Readonly<Record<string, ToolActionContract>>)[name];
}

// A published name keeps its policy for the process lifetime: disconnect must not
// erase replay protection for turns that already executed that tool.
const dynamicContracts = new Map<string, ToolActionContract>();
const policySets: Array<{ predicate: (value: ToolActionContract) => boolean; names: Set<string> }> =
  [];

export function getToolContract(name: string): ToolActionContract | undefined {
  return getBuiltInToolContract(name) ?? dynamicContracts.get(name);
}

export function publishToolContract(name: string, value: ToolActionContract): ToolActionContract {
  validateToolContract(value);
  const previous = getToolContract(name);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value)) {
    throw new Error(`Tool ${name} cannot change its published action contract`);
  }
  if (previous) return previous;
  const frozen = Object.freeze({
    ...value,
    gates: Object.freeze([...value.gates]),
    idempotency: value.idempotency
      ? Object.freeze({
          ...value.idempotency,
          target: Object.freeze([...value.idempotency.target]),
        })
      : null,
  });
  dynamicContracts.set(name, frozen);
  for (const { predicate, names } of policySets) if (predicate(frozen)) names.add(name);
  return frozen;
}

export function toolNamesMatching(
  predicate: (value: ToolActionContract) => boolean,
): ReadonlySet<string> {
  const names = new Set(
    [...Object.entries(BUILT_IN_TOOL_CONTRACTS), ...dynamicContracts.entries()]
      .filter(([, value]) => predicate(value))
      .map(([name]) => name),
  );
  policySets.push({ predicate, names });
  return names;
}

export function validateToolContract(value: ToolActionContract): void {
  if (
    !value ||
    !['readonly', 'local_state', 'intervention_intent', 'external_action'].includes(value.effect) ||
    !['allow', 'block_on_success'].includes(value.replay) ||
    !['none', 'latest_input'].includes(value.freshness) ||
    !Number.isInteger(value.maxCallsPerTurn) ||
    value.maxCallsPerTurn < 1 ||
    !Array.isArray(value.gates) ||
    (value.effect === 'external_action' && !value.idempotency)
  ) {
    throw new Error('A complete tool action contract is required');
  }
}
