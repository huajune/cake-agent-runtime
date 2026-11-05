/** Runtime invariants, separate from the model-visible tool schema. */
export const TOOL_EFFECT = {
  READONLY: 'readonly',
  LOCAL_STATE: 'local_state',
  INTERVENTION_INTENT: 'intervention_intent',
  EXTERNAL_ACTION: 'external_action',
} as const;
export type ToolEffect = (typeof TOOL_EFFECT)[keyof typeof TOOL_EFFECT];

export const TOOL_REPLAY = { ALLOW: 'allow', BLOCK_ON_SUCCESS: 'block_on_success' } as const;
export type ToolReplay = (typeof TOOL_REPLAY)[keyof typeof TOOL_REPLAY];

export const TOOL_FRESHNESS = { NONE: 'none', LATEST_INPUT: 'latest_input' } as const;
export type ToolFreshness = (typeof TOOL_FRESHNESS)[keyof typeof TOOL_FRESHNESS];

export const TOOL_IDEMPOTENCY_SCOPE = { BUSINESS: 'business', TURN: 'turn' } as const;
export type ToolIdempotencyScope =
  (typeof TOOL_IDEMPOTENCY_SCOPE)[keyof typeof TOOL_IDEMPOTENCY_SCOPE];

/** Shared by tool declarations and the audit catalog; tools must not import agent. */
export const TOOL_GATE = {
  JOB_LIST_BRAND_PROVENANCE: 'job_list_brand_provenance',
  JOB_LIST_SCHEDULE_CONSTRAINT_PROVENANCE: 'job_list_schedule_constraint_provenance',
  BOOKING_JOBID_PROVENANCE: 'booking_jobid_provenance',
  BOOKING_PRECHECK_CONTRACT: 'booking_precheck_contract',
  BOOKING_REAL_NAME: 'booking_real_name',
  BOOKING_NAME_AUTHORITY: 'booking_name_authority',
  CANCEL_WORK_ORDER_OWNERSHIP: 'cancel_work_order_ownership',
  MODIFY_WORK_ORDER_OWNERSHIP: 'modify_work_order_ownership',
  INVITE_CITY_PROVENANCE: 'invite_city_provenance',
  INVITE_TIMING_GATE: 'invite_timing_gate',
  IMAGE_MESSAGE_ALLOWLIST: 'image_message_allowlist',
} as const;
export type ToolGate = (typeof TOOL_GATE)[keyof typeof TOOL_GATE];

export const TOOL_SOURCE = { BUILT_IN: 'built-in', MCP: 'mcp' } as const;
export type ToolSource = (typeof TOOL_SOURCE)[keyof typeof TOOL_SOURCE];

export interface ToolActionContract {
  effect: ToolEffect;
  replay: ToolReplay;
  freshness: ToolFreshness;
  maxCallsPerTurn: number;
  gates: readonly ToolGate[];
  /** Semantic target; not a permanent operation ID. A persisted intent supplies its version. */
  idempotency: {
    scope: ToolIdempotencyScope;
    target: readonly string[];
  } | null;
}
