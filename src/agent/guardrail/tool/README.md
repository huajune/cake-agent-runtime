# Tool Guardrails

This folder is the guardrail module's visible entry point for tool-layer defenses.

Runtime enforcement stays in `src/tools/**` because tools must not depend back on
`src/agent/guardrail/**`. The catalog here records the tool guardrails in the same
shape as input/output guardrails: stage, action, priority, owner, source,
residual risk, and verification.

Key implementation files:

- `src/tools/duliday-interview-precheck.tool.ts`
- `src/tools/duliday-interview-booking.tool.ts`
- `src/tools/booking/booking-guards.util.ts`
- `src/resolution/evidence/identity-gates.ts`
- `src/tools/job-list/hard-requirements.util.ts`
