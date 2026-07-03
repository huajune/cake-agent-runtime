-- 出站守卫审查全程档案（guardrail_review_records）
--
-- 背景：message_processing_records.guardrail_output 只存紧凑摘要（stage/decision/ruleIds），
-- 首版全文、违规证据全文、重写版全文在内存中用完即弃，Dashboard 详情页无法还原
-- 「首版 → 首审意见 → 重写版 → 二审」全过程。
--
-- 设计：稀疏附属表——仅出站守卫命中（非 pass 或有 rule 观测命中）的回合写入一行，
-- 与主流水表 1:0..1，按 trace_id 关联。触发率低，全文体积不影响主表行宽
--（deTOAST 教训约束的是随每条 turn 写入的列，本表天然绕开）。

CREATE TABLE IF NOT EXISTS guardrail_review_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 关联与维度
  trace_id TEXT NOT NULL,
  chat_id TEXT,
  user_id TEXT,
  bot_im_id TEXT,
  bot_user_name TEXT,
  contact_name TEXT,
  user_message TEXT,

  -- 首审（现有紧凑摘要之外的全文部分）
  first_reply TEXT NOT NULL,
  first_decision TEXT NOT NULL,
  first_risk_level TEXT,
  first_rule_ids TEXT[] NOT NULL DEFAULT '{}',
  first_blocked_rule_ids TEXT[] NOT NULL DEFAULT '{}',
  first_violations JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_feedback TEXT,
  repair_mode TEXT,

  -- 受控修复与二审
  repaired BOOLEAN NOT NULL DEFAULT false,
  revised_reply TEXT,
  revised_decision TEXT,
  revised_risk_level TEXT,
  revised_rule_ids TEXT[],
  revised_blocked_rule_ids TEXT[],
  revised_violations JSONB,
  committed_side_effects TEXT,

  -- 收敛
  final_decision TEXT NOT NULL,
  reason_code TEXT
);

COMMENT ON TABLE guardrail_review_records IS '出站守卫审查全程档案：仅守卫命中回合写入，按 trace_id 关联 message_processing_records（1:0..1）。存首版全文/违规证据全文/重写版全文，供 Dashboard 详情页还原首审→修复→二审过程';
COMMENT ON COLUMN guardrail_review_records.trace_id IS '等于 message_processing_records.message_id';
COMMENT ON COLUMN guardrail_review_records.first_reply IS '首版回复全文（被守卫审查的原始文案，触发 revise/replan 时会被丢弃重写）';
COMMENT ON COLUMN guardrail_review_records.first_violations IS 'GuardViolation[]：type/evidence/suggestion/severity 等证据全文';
COMMENT ON COLUMN guardrail_review_records.first_feedback IS 'feedbackToGenerator 聚合文本，即注入重写 prompt 的违规反馈';
COMMENT ON COLUMN guardrail_review_records.revised_reply IS '受控修复后的重写版全文；repaired=false 时为空';
COMMENT ON COLUMN guardrail_review_records.committed_side_effects IS '重写时注入的既成副作用提示（解释重写版为何保留某些承诺）';
COMMENT ON COLUMN guardrail_review_records.reason_code IS '收敛归因码：repair_exhausted / revise_empty 等';

CREATE UNIQUE INDEX IF NOT EXISTS idx_guardrail_review_trace ON guardrail_review_records (trace_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_review_created ON guardrail_review_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardrail_review_chat ON guardrail_review_records (chat_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_review_rules ON guardrail_review_records USING GIN (first_rule_ids);

-- RLS：沿用观测表既有约定（public 读，service_role 写）
ALTER TABLE guardrail_review_records ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'guardrail_review_records' AND policyname = 'Allow public read'
  ) THEN
    CREATE POLICY "Allow public read" ON guardrail_review_records AS PERMISSIVE FOR SELECT TO public USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'guardrail_review_records' AND policyname = 'Service role insert'
  ) THEN
    CREATE POLICY "Service role insert" ON guardrail_review_records AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'guardrail_review_records' AND policyname = 'Service role delete'
  ) THEN
    CREATE POLICY "Service role delete" ON guardrail_review_records AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
END $$;
