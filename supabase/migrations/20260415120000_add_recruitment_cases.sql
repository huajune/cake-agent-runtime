-- ============================================================
-- recruitment_cases: 约面后跟进 Case（onboard_followup）
-- ============================================================

CREATE TABLE IF NOT EXISTS recruitment_cases (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  corp_id text NOT NULL,
  chat_id text NOT NULL,
  user_id text,
  case_type text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  booking_id text,
  booked_at timestamptz,
  interview_time text,
  job_id bigint,
  job_name text,
  brand_name text,
  store_name text,
  bot_im_id text,
  followup_window_ends_at timestamptz,
  last_relevant_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE recruitment_cases
  DROP CONSTRAINT IF EXISTS recruitment_cases_case_type_check;

ALTER TABLE recruitment_cases
  ADD CONSTRAINT recruitment_cases_case_type_check
  CHECK (case_type IN ('onboard_followup'));

ALTER TABLE recruitment_cases
  DROP CONSTRAINT IF EXISTS recruitment_cases_status_check;

ALTER TABLE recruitment_cases
  ADD CONSTRAINT recruitment_cases_status_check
  CHECK (status IN ('active', 'handoff', 'closed', 'expired'));

CREATE INDEX IF NOT EXISTS idx_recruitment_cases_chat
  ON recruitment_cases (corp_id, chat_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_recruitment_cases_user
  ON recruitment_cases (user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recruitment_cases_open_unique
  ON recruitment_cases (corp_id, chat_id, case_type)
  WHERE status IN ('active', 'handoff');

CREATE OR REPLACE FUNCTION update_recruitment_cases_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_recruitment_cases_updated_at ON recruitment_cases;
CREATE TRIGGER trigger_recruitment_cases_updated_at
  BEFORE UPDATE ON recruitment_cases
  FOR EACH ROW
  EXECUTE FUNCTION update_recruitment_cases_updated_at();

ALTER TABLE recruitment_cases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on recruitment_cases" ON recruitment_cases;
CREATE POLICY "Service role full access on recruitment_cases"
  ON recruitment_cases
  FOR ALL
  USING (true)
  WITH CHECK (true);
