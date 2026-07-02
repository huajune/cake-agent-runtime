-- Secure candidate_blacklist access.
--
-- candidate_blacklist contains candidate identifiers and blacklist metadata.
-- It is accessed by the backend with the Supabase service role, so it should
-- not remain unrestricted in the public schema.

ALTER TABLE candidate_blacklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on candidate_blacklist" ON candidate_blacklist;
CREATE POLICY "Service role full access on candidate_blacklist"
  ON candidate_blacklist
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
