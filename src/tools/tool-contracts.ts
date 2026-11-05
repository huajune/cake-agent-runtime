import { RUNTIME_RETRY_LIMITS } from '@infra/config/constants/runtime-retry.constants';
import type { ToolActionContract } from '@shared-types/tool-action.contract';
import {
  TOOL_EFFECT,
  TOOL_FRESHNESS,
  TOOL_GATE,
  TOOL_IDEMPOTENCY_SCOPE,
  TOOL_REPLAY,
} from '@shared-types/tool-action.contract';
import { z } from 'zod';

export const DEFAULT_TOOL_CALL_LIMIT = RUNTIME_RETRY_LIMITS.sameToolCalls;

function contract(
  effect: ToolActionContract['effect'],
  options: Partial<Omit<ToolActionContract, 'effect'>> = {},
): ToolActionContract {
  return Object.freeze({
    effect,
    replay: TOOL_REPLAY.ALLOW,
    freshness: TOOL_FRESHNESS.NONE,
    maxCallsPerTurn: DEFAULT_TOOL_CALL_LIMIT,
    gates: [],
    idempotency: null,
    ...options,
  });
}

/** Single declaration used by registration, replay and per-turn limits. No model schema changes. */
export const BUILT_IN_TOOL_CONTRACTS = {
  advance_stage: contract(TOOL_EFFECT.LOCAL_STATE),
  recall_history: contract(TOOL_EFFECT.READONLY),
  duliday_job_list: contract(TOOL_EFFECT.READONLY, {
    gates: [TOOL_GATE.JOB_LIST_BRAND_PROVENANCE, TOOL_GATE.JOB_LIST_SCHEDULE_CONSTRAINT_PROVENANCE],
  }),
  duliday_interview_precheck: contract(TOOL_EFFECT.LOCAL_STATE, {
    maxCallsPerTurn: RUNTIME_RETRY_LIMITS.precheckCalls,
    gates: [TOOL_GATE.BOOKING_JOBID_PROVENANCE],
  }),
  duliday_interview_booking: contract(TOOL_EFFECT.EXTERNAL_ACTION, {
    replay: TOOL_REPLAY.BLOCK_ON_SUCCESS,
    freshness: TOOL_FRESHNESS.LATEST_INPUT,
    gates: [
      TOOL_GATE.BOOKING_JOBID_PROVENANCE,
      TOOL_GATE.BOOKING_PRECHECK_CONTRACT,
      TOOL_GATE.BOOKING_REAL_NAME,
      TOOL_GATE.BOOKING_NAME_AUTHORITY,
    ],
    idempotency: { scope: TOOL_IDEMPOTENCY_SCOPE.BUSINESS, target: ['candidatePhone', 'jobId'] },
  }),
  duliday_cancel_work_order: contract(TOOL_EFFECT.EXTERNAL_ACTION, {
    replay: TOOL_REPLAY.BLOCK_ON_SUCCESS,
    gates: [TOOL_GATE.CANCEL_WORK_ORDER_OWNERSHIP],
    idempotency: { scope: TOOL_IDEMPOTENCY_SCOPE.BUSINESS, target: ['workOrderId'] },
  }),
  duliday_modify_interview_time: contract(TOOL_EFFECT.EXTERNAL_ACTION, {
    replay: TOOL_REPLAY.BLOCK_ON_SUCCESS,
    gates: [TOOL_GATE.MODIFY_WORK_ORDER_OWNERSHIP],
    idempotency: {
      scope: TOOL_IDEMPOTENCY_SCOPE.BUSINESS,
      target: ['workOrderId', 'interviewTime'],
    },
  }),
  geocode: contract(TOOL_EFFECT.READONLY, { gates: [TOOL_GATE.INVITE_CITY_PROVENANCE] }),
  send_store_location: contract(TOOL_EFFECT.EXTERNAL_ACTION, {
    replay: TOOL_REPLAY.BLOCK_ON_SUCCESS,
    idempotency: { scope: TOOL_IDEMPOTENCY_SCOPE.TURN, target: ['storeId'] },
  }),
  invite_to_group: contract(TOOL_EFFECT.EXTERNAL_ACTION, {
    replay: TOOL_REPLAY.BLOCK_ON_SUCCESS,
    gates: [TOOL_GATE.INVITE_CITY_PROVENANCE, TOOL_GATE.INVITE_TIMING_GATE],
    idempotency: { scope: TOOL_IDEMPOTENCY_SCOPE.BUSINESS, target: ['chatId', 'groupId'] },
  }),
  raise_risk_alert: contract(TOOL_EFFECT.INTERVENTION_INTENT),
  request_handoff: contract(TOOL_EFFECT.INTERVENTION_INTENT),
  skip_reply: contract(TOOL_EFFECT.LOCAL_STATE),
  save_image_description: contract(TOOL_EFFECT.LOCAL_STATE, {
    gates: [TOOL_GATE.IMAGE_MESSAGE_ALLOWLIST],
  }),
  read_resume_attachment: contract(TOOL_EFFECT.LOCAL_STATE),
} as const satisfies Record<string, ToolActionContract>;

export function getBuiltInToolContract(name: string): ToolActionContract | undefined {
  return (BUILT_IN_TOOL_CONTRACTS as Readonly<Record<string, ToolActionContract>>)[name];
}

// A published name keeps its policy for the process lifetime: disconnect must not
// erase replay protection for turns that already executed that tool.
const dynamicContracts = new Map<string, ToolActionContract>();
const policySets: Array<{ predicate: (value: ToolActionContract) => boolean; names: Set<string> }> =
  [];

export function getToolCallLimit(name: string): number {
  return getToolContract(name)?.maxCallsPerTurn ?? DEFAULT_TOOL_CALL_LIMIT;
}

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

const toolActionContractSchema = z
  .object({
    effect: z.enum(TOOL_EFFECT),
    replay: z.enum(TOOL_REPLAY),
    freshness: z.enum(TOOL_FRESHNESS),
    maxCallsPerTurn: z.number().int().positive(),
    gates: z.array(z.enum(TOOL_GATE)),
    idempotency: z
      .object({
        scope: z.enum(TOOL_IDEMPOTENCY_SCOPE),
        target: z.array(z.string().trim().min(1)).min(1),
      })
      .nullable(),
  })
  .refine((value) => value.effect !== TOOL_EFFECT.EXTERNAL_ACTION || value.idempotency !== null);

export function validateToolContract(value: unknown): asserts value is ToolActionContract {
  if (!toolActionContractSchema.safeParse(value).success) {
    throw new Error('A complete tool action contract is required');
  }
}
