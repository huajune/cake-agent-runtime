-- Add guardrail observability columns to message_processing_records
-- guardrail_input: inbound guard verdict (non-null only when blocked)
-- guardrail_output: outbound guard verdict (pass/revise/block, always present when agent ran)

ALTER TABLE message_processing_records
  ADD COLUMN IF NOT EXISTS guardrail_input  JSONB,
  ADD COLUMN IF NOT EXISTS guardrail_output JSONB;

COMMENT ON COLUMN message_processing_records.guardrail_input  IS '入站守卫裁决摘要（GuardrailInputTrace）：{ decision, riskType, riskLabel, reason, reasonCode }，仅 block 时非空';
COMMENT ON COLUMN message_processing_records.guardrail_output IS '出站守卫全程 trace（GuardrailTurnTrace）：{ steps: [{ stage, decision, riskLevel, ruleIds, blockedRuleIds, violationTypes, repairMode, reasonCode }], repaired, finalDecision, reasonCode }，Agent 过守卫后记录（紧凑摘要，不含证据全文）';
