-- psql -X -v kind=action [-v after='<next_after JSON>'] -f scripts/audit-runtime-storage.sql
-- One indexed page. Run each kind (chat/action) until scanned = 0. Save the output.
\set ON_ERROR_STOP on
\if :{?after}
\else
  \set after null
\endif
\if :{?batch_size}
\else
  \set batch_size 100
\endif
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT :'kind' = 'chat' AS chat, :'kind' = 'action' AS action,
  :'batch_size'::integer BETWEEN 1 AND 100 AND (:'after'::jsonb = 'null' OR (
    :'after'::jsonb->>'type' = :'kind' AND nullif(:'after'::jsonb->>'id','') IS NOT NULL
    AND (:'kind' = 'chat' OR nullif(:'after'::jsonb->>'corp','') IS NOT NULL))) IS TRUE AS valid
\gset
\if :valid
\else
  DO $$ BEGIN RAISE EXCEPTION 'Expected a batch size of 1..100 and a cursor for the same kind'; END $$;
\endif
\if :chat
  SELECT coalesce(jsonb_agg(jsonb_build_object('key',jsonb_build_object('type','chat','id',b.message_id),
    'state',public.chat_body_storage_state(b),'new_form',b.payload_text_v1 IS NOT NULL AND b.payload IS NOT NULL)
    ORDER BY b.message_id),'[]') AS page
  FROM (SELECT c.* FROM public.chat_messages c WHERE :'after'::jsonb = 'null'
    OR c.message_id > (:'after'::jsonb->>'id') ORDER BY c.message_id LIMIT :'batch_size'::integer) b
  \gset
\elif :action
  SELECT coalesce(jsonb_agg(jsonb_build_object('key',jsonb_build_object('type','action','corp',b.corp_id,'id',b.action_id),
    'state',public.action_body_storage_state(b),'new_form',b.body_ref_v1 IS TRUE AND b.status='failed')
    ORDER BY b.corp_id,b.action_id),'[]') AS page
  FROM (SELECT a.* FROM public.agent_action_records a WHERE :'after'::jsonb = 'null'
    OR (a.corp_id,a.action_id) > (:'after'::jsonb->>'corp',:'after'::jsonb->>'id')
    ORDER BY a.corp_id,a.action_id LIMIT :'batch_size'::integer) b
  \gset
\else
  DO $$ BEGIN RAISE EXCEPTION 'Expected kind=chat or kind=action'; END $$;
\endif
WITH rows AS (SELECT v->>'state' AS state, v->'key' AS key, v->'new_form' AS new_form, ord
  FROM jsonb_array_elements(:'page'::jsonb) WITH ORDINALITY AS entries(v,ord))
SELECT jsonb_build_object('scanned',count(*),'states',
    (SELECT coalesce(jsonb_object_agg(state,n),'{}') FROM (SELECT state,count(*) AS n FROM rows GROUP BY state) groups),
  'broken',count(*) FILTER (WHERE state IN ('broken_reference','missing_receipt')),
  'eligible_keys',CASE WHEN count(*) FILTER (WHERE state IN ('broken_reference','missing_receipt'))=0
    THEN coalesce(jsonb_agg(key ORDER BY ord) FILTER (WHERE state='eligible'),'[]') ELSE '[]'::jsonb END,
  'restore_keys',coalesce(jsonb_agg(key ORDER BY ord) FILTER (WHERE state='already_referenced' AND new_form='true'),'[]'),
  'next_after',(:'page'::jsonb)->-1->'key') AS audit FROM rows;
COMMIT;
