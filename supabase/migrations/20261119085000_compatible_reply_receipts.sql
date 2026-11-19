-- Acceptance of the send request and a self-message callback are two different
-- successful observations of the same managed dispatch. Keep each original receipt.
CREATE OR REPLACE FUNCTION public.action_terminal_evidence(p_corp text,p_action text,p_attempt text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  WITH terminals AS (
    SELECT DISTINCT e.completion, a.kind
    FROM public.agent_action_evidence e JOIN public.agent_action_records a
      ON a.corp_id=e.corp_id AND a.action_id=e.action_id
    WHERE e.corp_id=p_corp AND e.action_id=p_action AND e.attempt_id=p_attempt
      AND e.completion#>'{evidence,requestTerminated}'='true'::jsonb
      AND (e.completion->>'status'='succeeded' OR (e.completion->>'status'='failed'
        AND e.completion#>>'{evidence,kind}'='definitive_no_effect'))
  ), classified AS (
    SELECT completion, CASE WHEN kind='wecom.reply_segment' AND completion->>'status'='succeeded' THEN
      CASE WHEN completion->'result'='{"stage":"accepted"}'::jsonb
            AND completion#>>'{evidence,kind}'='accepted' AND completion#>>'{evidence,externalId}' IS NULL
        THEN 'accepted'
        WHEN completion#>>'{result,stage}'='delivery_callback' AND completion#>>'{evidence,kind}'='completed'
            AND jsonb_typeof(completion#>'{result,channelMessageId}')='string'
            AND nullif(completion#>>'{result,channelMessageId}','') IS NOT NULL
            AND completion#>'{result,channelMessageId}'=completion#>'{evidence,externalId}'
            AND ((completion->'result') - ARRAY['stage','channelMessageId'])='{}'::jsonb
        THEN 'delivery_callback' END END AS stage
    FROM terminals
  )
  SELECT CASE
    WHEN count(*)=0 THEN '{"conflicting":false}'::jsonb
    WHEN count(*)=1 OR (count(stage)=count(*) AND
      count(DISTINCT completion#>>'{result,channelMessageId}') FILTER (WHERE stage='delivery_callback')<=1)
    THEN jsonb_build_object('conflicting',false,'completion',(
      SELECT completion FROM classified ORDER BY (stage='delivery_callback') DESC NULLS LAST,completion LIMIT 1
    ))
    ELSE '{"conflicting":true}'::jsonb END
  FROM classified;
$$;
REVOKE ALL ON FUNCTION public.action_terminal_evidence(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.action_terminal_evidence(text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
