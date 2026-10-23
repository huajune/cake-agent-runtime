/** Runtime invariants, separate from the model-visible tool schema. */
export interface ToolActionContract {
  effect: 'readonly' | 'local_state' | 'intervention_intent' | 'external_action';
  replay: 'allow' | 'block_on_success';
  freshness: 'none' | 'latest_input';
  maxCallsPerTurn: number;
  gates: readonly string[];
  /** Semantic target; not a permanent operation ID. A persisted intent supplies its version. */
  idempotency: {
    scope: 'business' | 'turn';
    target: readonly string[];
  } | null;
}
