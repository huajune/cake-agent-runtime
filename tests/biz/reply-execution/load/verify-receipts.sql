-- Fresh successful segments must each have a receipt for the original dispatch and adopted result.
WITH actions AS (
  SELECT a.corp_id, count(*) AS actions, count(*) FILTER (
    WHERE a.status = 'succeeded' AND a.local_sync = 'complete' AND EXISTS (
      SELECT FROM public.agent_action_evidence e
      WHERE (e.corp_id, e.action_id, e.attempt_id) = (a.corp_id, a.action_id, a.dispatch_attempt_id)
        AND e.completion->>'status' = a.status
        AND e.completion->'result' = a.result AND e.completion->'evidence' = a.evidence
        AND e.evidence_hash = encode(sha256(convert_to(e.completion::text, 'UTF8')), 'hex')
    )) AS matched
  FROM public.agent_action_records a
  WHERE a.corp_id LIKE 'benchdb-%' OR a.corp_id LIKE 'benchq-%'
  GROUP BY a.corp_id
), receipts AS (
  SELECT corp_id, count(*) AS receipts
  FROM public.agent_action_evidence
  WHERE corp_id LIKE 'benchdb-%' OR corp_id LIKE 'benchq-%'
  GROUP BY corp_id
), runs AS (
  SELECT CASE WHEN corp_id LIKE 'benchdb-%' THEN 'database' ELSE 'queue' END AS phase,
    coalesce(actions, 0) AS actions, coalesce(receipts, 0) AS receipts, coalesce(matched, 0) AS matched
  FROM actions FULL JOIN receipts USING (corp_id)
)
SELECT coalesce(bool_and(actions = receipts AND actions = matched), false) AS passed,
       json_agg(runs ORDER BY phase, actions)::text AS cohorts
FROM runs
\gset
\echo :cohorts
\if :passed
\else
  DO $$ BEGIN RAISE EXCEPTION 'an accepted action or receipt did not match'; END $$;
\endif
