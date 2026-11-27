BEGIN;
SET LOCAL lock_timeout='3s';

-- v11.22 renamed the original snapshot table and reused its name for HTTP attempts.
-- Either migration order must yield the same parent/child ownership and permissions.
ALTER TABLE public.message_processing_turn_snapshots ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.message_processing_invocations ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES public.tenants(id);

CREATE OR REPLACE FUNCTION public.inherit_processing_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE trace text;
BEGIN
  IF TG_TABLE_NAME IN ('message_processing_turn_snapshots','message_processing_invocations') THEN trace:=NEW.message_id;
  ELSE trace:=NEW.trace_id; END IF;
  IF trace IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cake.trace.'||trace,0));
    SELECT r.tenant_id INTO NEW.tenant_id FROM message_processing_records r WHERE r.message_id=trace;
  ELSE NEW.tenant_id:=NULL; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.propagate_processing_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.trace.'||NEW.message_id,0));
  UPDATE agent_execution_events SET tenant_id=NEW.tenant_id WHERE trace_id=NEW.message_id AND tenant_id IS DISTINCT FROM NEW.tenant_id;
  UPDATE guardrail_review_records SET tenant_id=NEW.tenant_id WHERE trace_id=NEW.message_id AND tenant_id IS DISTINCT FROM NEW.tenant_id;
  UPDATE message_processing_turn_snapshots SET tenant_id=NEW.tenant_id WHERE message_id=NEW.message_id AND tenant_id IS DISTINCT FROM NEW.tenant_id;
  UPDATE message_processing_invocations SET tenant_id=NEW.tenant_id WHERE message_id=NEW.message_id AND tenant_id IS DISTINCT FROM NEW.tenant_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inherit_invocation_tenant ON public.message_processing_turn_snapshots;
DROP TRIGGER IF EXISTS inherit_invocation_tenant ON public.message_processing_invocations;
CREATE TRIGGER inherit_turn_snapshot_tenant BEFORE INSERT OR UPDATE OF message_id,tenant_id
  ON public.message_processing_turn_snapshots FOR EACH ROW EXECUTE FUNCTION public.inherit_processing_tenant();
CREATE TRIGGER inherit_invocation_tenant BEFORE INSERT OR UPDATE OF message_id,tenant_id
  ON public.message_processing_invocations FOR EACH ROW EXECUTE FUNCTION public.inherit_processing_tenant();

-- Model bytes are immutable. Parent ownership can be resolved after a child was saved.
REVOKE UPDATE ON public.message_processing_invocations FROM service_role;
GRANT UPDATE(tenant_id) ON public.message_processing_invocations TO service_role;
GRANT UPDATE(tenant_id) ON public.message_processing_turn_snapshots TO service_role;
UPDATE public.message_processing_turn_snapshots s SET tenant_id=r.tenant_id
FROM public.message_processing_records r WHERE r.message_id=s.message_id AND s.tenant_id IS DISTINCT FROM r.tenant_id;
UPDATE public.message_processing_invocations i SET tenant_id=r.tenant_id
FROM public.message_processing_records r WHERE r.message_id=i.message_id AND i.tenant_id IS DISTINCT FROM r.tenant_id;

-- The released app uses the request/response RPC. The retired overload accepts obsolete columns.
DROP FUNCTION IF EXISTS public.save_processing_snapshot(jsonb,jsonb);

CREATE OR REPLACE FUNCTION public.save_processing_snapshot(p_record jsonb, p_request jsonb, p_response jsonb, p_invocations jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  allowed constant text[] := ARRAY['message_id','chat_id','received_at','status','user_id','user_name','manager_name',
    'bot_im_id','source_occurred_at','message_preview','reply_preview','reply_segments','error','alert_type','scenario','total_duration',
    'queue_duration','prep_duration','ai_duration','ttft_ms','send_duration','token_usage','is_fallback','fallback_success',
    'batch_id','tool_calls','agent_steps','anomaly_flags','guardrail_input','guardrail_output','memory_snapshot','post_processing_status'];
  cols text; updates text; conflict_action text; steps jsonb := p_record->'agent_steps';
  steps_only boolean := p_record ? 'agent_steps' AND NOT p_record ? 'tool_calls';
BEGIN
  IF jsonb_typeof(p_record) IS DISTINCT FROM 'object' OR NOT (p_record ?& ARRAY['message_id','chat_id','received_at','status'])
    OR (p_record-allowed)<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid processing record'; END IF;
  IF p_record ? 'agent_steps' THEN
    p_record := p_record || public.processing_step_layout(p_record->'agent_steps',p_record->'tool_calls');
  END IF;
  SELECT string_agg(quote_ident(k),',' ORDER BY k),
    string_agg(format('%1$I=excluded.%1$I',k),',' ORDER BY k) FILTER(WHERE k<>'message_id' AND (k<>'tool_calls' OR NOT steps_only))
    INTO cols,updates FROM jsonb_object_keys(p_record) AS k;
  -- A steps-only patch remaps the current tool bodies under the upsert's row
  -- lock. A concurrent writer's parameters and results remain authoritative.
  IF steps_only THEN
    updates := updates || ',tool_calls=public.processing_step_layout($2,message_processing_records.tool_calls)->''tool_calls''';
  END IF;
  -- Intake is asynchronous and may arrive after generation or settlement.
  -- Replaying the first observation must preserve the original receipt time,
  -- captured model bytes and any later delivery outcome.
  IF p_record->>'status'='processing' AND p_request IS NULL AND p_response IS NULL
    AND p_record-ARRAY['message_id','chat_id','received_at','status','user_id','user_name',
      'manager_name','bot_im_id','source_occurred_at','message_preview','scenario','batch_id']='{}'::jsonb THEN
    conflict_action := 'DO UPDATE SET
      bot_im_id=coalesce(message_processing_records.bot_im_id,excluded.bot_im_id),
      source_occurred_at=coalesce(message_processing_records.source_occurred_at,excluded.source_occurred_at)
      WHERE message_processing_records.chat_id=excluded.chat_id
        AND (message_processing_records.bot_im_id IS NULL OR message_processing_records.bot_im_id=excluded.bot_im_id)
        AND ((message_processing_records.source_occurred_at IS NULL AND excluded.source_occurred_at IS NOT NULL)
          OR (message_processing_records.bot_im_id IS NULL AND excluded.bot_im_id IS NOT NULL))';
  ELSE
    conflict_action := 'DO UPDATE SET ' || updates;
  END IF;
  EXECUTE format('INSERT INTO public.message_processing_records (%1$s)
    SELECT %1$s FROM jsonb_populate_record(NULL::public.message_processing_records,$1)
    ON CONFLICT(message_id) %2$s',cols,conflict_action) USING p_record,steps;
  IF p_request IS NOT NULL OR p_response IS NOT NULL THEN
    INSERT INTO public.message_processing_turn_snapshots(message_id,request,response)
      VALUES(p_record->>'message_id',p_request,CASE WHEN jsonb_typeof(p_response)='object' THEN p_response-ARRAY['toolCalls','agentSteps','memorySnapshot'] ELSE p_response END)
      ON CONFLICT(message_id) DO UPDATE SET request=excluded.request,response=excluded.response;
  END IF;
  INSERT INTO public.message_processing_invocations(message_id,id,started_at,provider,http_status,complete,request_body,response_body)
    SELECT p_record->>'message_id',a.id,a."startedAt",a.provider,a."httpStatus",a.complete,
      decode(a."requestBody",'base64'),decode(a."responseBody",'base64')
    FROM jsonb_to_recordset(p_invocations) AS a(id uuid,"startedAt" timestamptz,provider text,"httpStatus" smallint,
      complete boolean,"requestBody" text,"responseBody" text)
    ON CONFLICT (message_id,id) DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.save_processing_snapshot(jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_processing_snapshot(jsonb,jsonb,jsonb,jsonb) TO service_role;

create or replace function public.capture_ordinary_reply_processing(t public.agent_reply_turns, capture jsonb)
returns void language plpgsql set search_path=public,pg_temp as $$
declare
  trace text := t.recovery->>'traceId';
  m public.message_processing_records;
begin
  if nullif(trace,'') is null or capture#>>'{request,messageId}' is distinct from trace
    or capture#>>'{request,chatId}' is distinct from t.chat_id
    or capture#>>'{request,imBotId}' is distinct from t.account_id then
    raise exception 'reply processing identity mismatch';
  end if;
  -- Intake may still be writing the initial processing row.
  insert into public.message_processing_records(message_id,chat_id,bot_im_id,source_occurred_at,received_at,status)
    values(trace,t.chat_id,t.account_id,t.input_occurred_at,t.input_occurred_at,'processing') on conflict(message_id) do nothing;
  select * into strict m from public.message_processing_records where message_id=trace for update;
  if m.chat_id is distinct from t.chat_id or (m.bot_im_id is not null and m.bot_im_id<>t.account_id) then
    raise exception 'reply processing scope mismatch';
  end if;
  if m.status in ('success','failure') then return; end if;
  perform public.save_processing_snapshot((capture->'record') || jsonb_build_object(
    'message_id',trace,'chat_id',t.chat_id,'received_at',m.received_at,'source_occurred_at',t.input_occurred_at,'bot_im_id',t.account_id,'status','processing'),
    capture->'request',capture->'response',coalesce(capture->'invocations','[]'::jsonb));
end $$;
revoke all on function public.capture_ordinary_reply_processing(public.agent_reply_turns,jsonb) from public,anon,authenticated,service_role;

-- Keep the released list projection when tenant migrations are installed after v11.22.
CREATE OR REPLACE FUNCTION public.tenant_dashboard_processing_read(p_kind text, p_tenant_id text, p_start date, p_end date, p_params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
AS $function$
DECLARE v_result jsonb;
  v_start timestamptz := p_start::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';
BEGIN
  IF p_kind='processing-stats' THEN
    SELECT jsonb_build_object('total',count(*),'success',count(*) FILTER(WHERE status='success'),
      'failed',count(*) FILTER(WHERE status IN ('failure','timeout')),'avgDuration',coalesce(avg(total_duration),0),'avgTtft',coalesce(avg(ttft_ms),0)) INTO v_result
    FROM public.tenant_visible_message_processing_records WHERE tenant_id=p_tenant_id AND received_at>=v_start AND received_at<v_end
      AND (p_params->>'userName' IS NULL OR strpos(lower(coalesce(user_name,'')),lower(p_params->>'userName'))>0)
      AND (NOT p_params ? 'managerNames' OR manager_name IN (SELECT jsonb_array_elements_text(p_params->'managerNames')));
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO v_result FROM (
      SELECT message_id AS "messageId",chat_id AS "chatId",user_id AS "userId",user_name AS "userName",manager_name AS "managerName",bot_im_id AS "botImId",
        extract(epoch FROM received_at)*1000 AS "receivedAt",CASE WHEN p_kind='processing-detail' THEN message_preview ELSE left(message_preview,50) END AS "messagePreview",
        CASE WHEN p_kind='processing-detail' THEN reply_preview ELSE left(reply_preview,120) END AS "replyPreview",reply_segments AS "replySegments",
        status,scenario,total_duration AS "totalDuration",queue_duration AS "queueDuration",prep_duration AS "prepDuration",ai_duration AS "aiDuration",
        ttft_ms AS "ttftMs",send_duration AS "sendDuration",token_usage AS "tokenUsage",is_fallback AS "isFallback",fallback_success AS "fallbackSuccess",batch_id AS "batchId"
      FROM public.tenant_visible_message_processing_records WHERE tenant_id=p_tenant_id
        AND ((p_kind='processing-detail' AND message_id=p_params->>'id') OR
          (p_kind<>'processing-detail' AND received_at>=v_start AND received_at<v_end))
        AND (p_params->>'status' IS NULL OR status=p_params->>'status')
        AND (p_params->>'chatId' IS NULL OR chat_id=p_params->>'chatId')
        AND (p_params->>'userName' IS NULL OR strpos(lower(coalesce(user_name,'')),lower(p_params->>'userName'))>0)
        AND (NOT p_params ? 'managerNames' OR manager_name IN (SELECT jsonb_array_elements_text(p_params->'managerNames')))
      ORDER BY CASE WHEN p_kind='slowest' THEN ai_duration END DESC NULLS LAST,received_at DESC,message_id DESC
      LIMIT CASE WHEN p_kind='processing-detail' THEN 1 ELSE least(greatest(coalesce((p_params->>'limit')::int,50),1),200) END
      OFFSET least(greatest(coalesce((p_params->>'offset')::int,0),0),10000)
    ) r;
    IF p_kind='processing-detail' THEN RETURN v_result->0; END IF;
  END IF;
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.tenant_dashboard_processing_read(text,text,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_dashboard_processing_read(text,text,date,date,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
