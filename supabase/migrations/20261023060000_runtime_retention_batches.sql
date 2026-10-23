-- Observation rows have no execution/recovery obligations. Expired payloads can be
-- redacted without inventing a terminal success; execute obligations stay protected.
DROP INDEX IF EXISTS public.agent_action_retention_idx;
CREATE INDEX agent_action_retention_idx ON public.agent_action_records(updated_at)
  WHERE NOT retention_redacted AND (
    mode IN ('off','observe') OR
    (status IN ('succeeded','failed','cancelled') AND local_sync='complete')
  );

CREATE OR REPLACE FUNCTION public.redact_completed_agent_actions(p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET lock_timeout='1s' AS $$
DECLARE n integer;
BEGIN
  WITH batch AS (
    SELECT corp_id,action_id FROM public.agent_action_records
    WHERE updated_at<now()-interval '90 days' AND NOT retention_redacted AND (
      mode IN ('off','observe') OR
      (status IN ('succeeded','failed','cancelled') AND local_sync='complete')
    )
    ORDER BY updated_at LIMIT least(greatest(p_limit,1),100) FOR UPDATE SKIP LOCKED
  ), redacted AS (
    UPDATE public.agent_action_records a
    SET intent=a.intent-'parameters'-'recovery'-'target',result=NULL,evidence=NULL,retention_redacted=true
    FROM batch b WHERE a.corp_id=b.corp_id AND a.action_id=b.action_id
    RETURNING a.corp_id,a.action_id
  ), cleaned_reviews AS (
    UPDATE public.agent_action_reviews v SET completion=NULL
    FROM redacted r WHERE v.corp_id=r.corp_id AND v.action_id=r.action_id
  ), cleaned_evidence AS (
    DELETE FROM public.agent_action_evidence e USING redacted r
    WHERE e.corp_id=r.corp_id AND e.action_id=r.action_id
  )
  SELECT count(*) INTO n FROM redacted;
  -- Count action rows even when they have zero/multiple evidence rows.
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.redact_completed_agent_actions(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.redact_completed_agent_actions(integer) TO service_role;
