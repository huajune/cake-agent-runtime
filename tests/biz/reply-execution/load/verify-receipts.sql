-- Check the exact receipt selected by each successful action, including compacted bodies.
WITH actions AS (
  SELECT a.corp_id, count(*) AS actions,
    count(e.action_id) FILTER (WHERE a.status = 'succeeded' AND a.local_sync = 'complete') AS matched
  FROM public.agent_action_records a
  LEFT JOIN public.agent_action_evidence e
    ON (a.corp_id, a.action_id, a.accepted_attempt_id, a.accepted_evidence_hash)
     = (e.corp_id, e.action_id, e.attempt_id, e.evidence_hash)
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
