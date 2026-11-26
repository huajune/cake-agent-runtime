-- Coordinate this cutover with stopped writers. The lock also fences in-flight
-- snapshots. A failed conversion rolls back both the data and the DDL.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';
-- The existing one-per-turn rows keep their age, grants and stored business context.
DO $rename$
BEGIN
  IF to_regclass('public.message_processing_turn_snapshots') IS NULL THEN
    ALTER TABLE public.message_processing_invocations RENAME TO message_processing_turn_snapshots;
    ALTER INDEX public.idx_mp_invocations_created_at RENAME TO idx_mp_turn_snapshots_created_at;
  END IF;
END $rename$;
LOCK TABLE public.message_processing_records, public.message_processing_turn_snapshots IN ACCESS EXCLUSIVE MODE;

-- The tenant-enabled schema links SDK snapshots, events and reviews via trigger
-- functions that resolve the relation name at execution time. Preserve their
-- parent lookup, advisory locks, owner, privileges and the other two branches.
DO $tenant$
DECLARE target regprocedure; definition text;
BEGIN
  FOREACH target IN ARRAY ARRAY[to_regprocedure('public.inherit_processing_tenant()'),
      to_regprocedure('public.propagate_processing_tenant()')] LOOP
    CONTINUE WHEN target IS NULL;
    definition := pg_get_functiondef(target);
    IF strpos(definition,'message_processing_invocations')>0 THEN
      EXECUTE replace(definition,'message_processing_invocations','message_processing_turn_snapshots');
    END IF;
  END LOOP;
END $tenant$;

-- Some installations expose a service-only tenant projection. Rebuild just its
-- column list, preserving the existing visibility predicate, owner and grants.
DO $views$
DECLARE item record; target regclass; old_cols text; new_cols text; privileges text; owner_id oid; acl aclitem[];
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('tenant_visible_message_processing_records','message_processing_records',ARRAY['step_tools_v1','invocation_version']),
    ('tenant_visible_chat_messages','chat_messages',ARRAY['payload_text_v1'])
  ) AS v(view_name,base,removed) LOOP
    target:=to_regclass('public.'||item.view_name);
    CONTINUE WHEN target IS NULL OR NOT EXISTS (SELECT FROM pg_attribute
      WHERE attrelid=target AND attname=ANY(item.removed) AND NOT attisdropped);
    SELECT relowner,relacl INTO owner_id,acl FROM pg_class WHERE oid=target AND relkind='v'
      AND reloptions=ARRAY['security_invoker=true'];
    IF owner_id IS DISTINCT FROM current_user::regrole::oid OR acl IS NULL OR
      EXISTS (SELECT FROM aclexplode(acl) WHERE grantor<>owner_id OR
        (grantee<>owner_id AND (grantee<>'service_role'::regrole::oid OR is_grantable))) OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid=target AND attnum>0 AND attacl IS NOT NULL) THEN
      RAISE EXCEPTION 'Unexpected privileges or owner of %',target; END IF;
    SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),
      string_agg(quote_ident(attname),',' ORDER BY attnum)
        FILTER(WHERE NOT attname=ANY(item.removed))
      INTO old_cols,new_cols FROM pg_attribute WHERE attrelid=target AND attnum>0 AND NOT attisdropped;
    EXECUTE format('CREATE TEMP VIEW expected_storage_scope AS SELECT %s FROM public.%I WHERE tenant_id IS NOT NULL',old_cols,item.base);
    IF pg_get_viewdef(target)<>pg_get_viewdef('pg_temp.expected_storage_scope'::regclass) THEN
      RAISE EXCEPTION 'Unexpected tenant scope on %',target; END IF;
    DROP VIEW pg_temp.expected_storage_scope;
    SELECT string_agg(privilege_type,',') INTO privileges FROM aclexplode(acl) WHERE grantee='service_role'::regrole::oid;
    EXECUTE format('DROP VIEW public.%I RESTRICT',item.view_name);
    EXECUTE format('CREATE VIEW public.%I WITH (security_invoker=true) AS SELECT %s FROM public.%I WHERE tenant_id IS NOT NULL',item.view_name,new_cols,item.base);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',item.view_name);
    IF privileges IS NOT NULL THEN EXECUTE format('GRANT %s ON public.%I TO service_role',privileges,item.view_name); END IF;
  END LOOP;
END $views$;

-- Each tool body lives in tool_calls. stepPosition is its zero-based position
-- in this row's step array, including retries with a repeated SDK stepIndex.
CREATE OR REPLACE FUNCTION public.processing_step_layout(steps jsonb, calls jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  step jsonb; call jsonb; position integer; next_position integer := 0;
  used integer[] := '{}'; layout jsonb := '[]'; linked jsonb;
BEGIN
  IF jsonb_typeof(calls)='array' AND jsonb_path_exists(calls,'$[*].stepPosition') THEN
    SELECT jsonb_agg(CASE WHEN jsonb_typeof(item)='object' THEN item-'stepPosition' ELSE item END ORDER BY ord)
      INTO calls FROM jsonb_array_elements(calls) WITH ORDINALITY t(item,ord);
  END IF;
  IF jsonb_typeof(steps) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('agent_steps',NULL,'tool_calls',calls);
  END IF;
  IF calls IS NULL THEN
    SELECT jsonb_agg(c.item ORDER BY s.ord,c.ord) INTO calls
      FROM jsonb_array_elements(steps) WITH ORDINALITY s(step,ord)
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.step->'toolCalls')='array'
        THEN s.step->'toolCalls' ELSE '[]'::jsonb END) WITH ORDINALITY c(item,ord);
  END IF;
  linked := calls;
  FOR step IN SELECT value FROM jsonb_array_elements(steps) LOOP
    IF jsonb_typeof(step) <> 'object' THEN CONTINUE; END IF;
    IF jsonb_typeof(step->'toolCalls')='array' AND jsonb_typeof(calls)='array' THEN
      FOR call IN SELECT value FROM jsonb_array_elements(step->'toolCalls') LOOP
        CONTINUE WHEN jsonb_typeof(call)<>'object';
        IF calls->next_position = call AND NOT (next_position=ANY(used)) THEN
          position := next_position;
        ELSE
          SELECT CASE WHEN count(*)=1 THEN min(ord)::integer-1 END INTO position
          FROM jsonb_array_elements(calls) WITH ORDINALITY AS t(item,ord)
          WHERE NOT ((ord::integer-1)=ANY(used)) AND
            (item=call OR (nullif(call->>'toolCallId','') IS NOT NULL AND item->>'toolCallId'=call->>'toolCallId'));
        END IF;
        IF position IS NOT NULL THEN
          linked := jsonb_set(linked,ARRAY[position::text,'stepPosition'],to_jsonb(jsonb_array_length(layout)));
          used := array_append(used,position);
          next_position := position+1;
        END IF;
      END LOOP;
    END IF;
    layout := layout || jsonb_build_array(step-'toolCalls');
  END LOOP;
  RETURN jsonb_build_object('agent_steps',layout,'tool_calls',linked);
END $$;
REVOKE ALL ON FUNCTION public.processing_step_layout(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.processing_step_layout(jsonb,jsonb) TO service_role;

DROP TRIGGER IF EXISTS processing_guard_tools ON public.message_processing_records;
DROP TRIGGER IF EXISTS processing_accept_full_snapshot ON public.message_processing_turn_snapshots;

-- These two helpers live only in the migration session. Unverifiable old step
-- links are discarded; the parent status, tool list and remaining steps survive.
CREATE OR REPLACE FUNCTION pg_temp.unpack_old_steps(r public.message_processing_records)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.processing_read_steps(r);
EXCEPTION WHEN raise_exception OR data_exception THEN
  RETURN r.agent_steps;
END $$;

-- Converting the historical JSON bodies can exceed five minutes at production volume.
SET LOCAL statement_timeout = '15min';
DO $migration$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='public.message_processing_turn_snapshots'::regclass
      AND attname='agent_invocation' AND NOT attisdropped) THEN RETURN; END IF;
  ALTER TABLE public.message_processing_turn_snapshots ADD COLUMN request jsonb, ADD COLUMN response jsonb;
  DELETE FROM public.message_processing_turn_snapshots i USING public.message_processing_records r
    WHERE r.message_id=i.message_id AND i.response_tools_v1 IS NOT NULL AND
      (r.invocation_version IS NULL OR i.write_version IS DISTINCT FROM r.invocation_version
        OR i.response_tools_v1 IS DISTINCT FROM public.processing_tools_digest(r.tool_calls));
  GET DIAGNOSTICS n=ROW_COUNT;
  RAISE NOTICE 'Snapshots with unverifiable historical tool references omitted: %',n;
  DELETE FROM public.message_processing_turn_snapshots
    WHERE superseded_invocation IS NOT NULL OR jsonb_typeof(agent_invocation) IS DISTINCT FROM 'object'
      OR NOT (agent_invocation ?| ARRAY['request','response']);
  GET DIAGNOSTICS n=ROW_COUNT;
  RAISE NOTICE 'Historical snapshots without a current request or response omitted: %',n;

  CREATE TEMP TABLE processing_history ON COMMIT DROP AS
    SELECT r.id, coalesce(nullif(pg_temp.unpack_old_steps(r),'null'),i.agent_invocation#>'{response,agentSteps}') AS steps,
      coalesce(r.memory_snapshot,i.agent_invocation#>'{response,memorySnapshot}') AS memory,
      CASE WHEN jsonb_typeof(r.tool_calls)='array' AND r.tool_calls<>'[]'::jsonb THEN r.tool_calls
           WHEN jsonb_typeof(i.agent_invocation#>'{response,toolCalls}')='array'
                AND i.agent_invocation#>'{response,toolCalls}'<>'[]'::jsonb THEN i.agent_invocation#>'{response,toolCalls}'
           ELSE r.tool_calls END AS calls
    FROM public.message_processing_records r LEFT JOIN public.message_processing_turn_snapshots i USING(message_id)
    WHERE r.agent_steps IS NOT NULL OR (i.agent_invocation->'response') ?| ARRAY['toolCalls','agentSteps','memorySnapshot'];
  -- Some old records put calls solely inside the steps. Preserve their original order.
  UPDATE processing_history SET calls=NULL
    WHERE jsonb_typeof(steps)='array' AND (jsonb_typeof(calls) IS DISTINCT FROM 'array' OR calls='[]')
      AND jsonb_path_exists(steps,'$[*].toolCalls[*] ? (@.type() == "object")');
  WITH mapped AS MATERIALIZED (
    SELECT id,memory,public.processing_step_layout(steps,calls) AS data FROM processing_history
  )
  UPDATE public.message_processing_records r SET tool_calls=nullif(m.data->'tool_calls','null'), agent_steps=nullif(m.data->'agent_steps','null'),memory_snapshot=nullif(m.memory,'null')
    FROM mapped m WHERE r.id=m.id AND (r.tool_calls IS DISTINCT FROM nullif(m.data->'tool_calls','null')
      OR r.agent_steps IS DISTINCT FROM nullif(m.data->'agent_steps','null') OR r.memory_snapshot IS DISTINCT FROM nullif(m.memory,'null'));
  -- Early stream snapshots used SDK input/output/state. Convert this known
  -- representation once so the detail reader only needs args/result/status.
  UPDATE public.message_processing_records SET tool_calls=(
    SELECT jsonb_agg(CASE WHEN item ?| ARRAY['input','arguments','output','state'] THEN
      (item-ARRAY['input','arguments','output','state']) ||
      CASE WHEN item ?| ARRAY['input','arguments'] AND NOT item?'args'
        THEN jsonb_build_object('args',coalesce(item->'input',item->'arguments')) ELSE '{}'::jsonb END ||
      CASE WHEN item?'output' AND NOT item?'result'
        THEN jsonb_build_object('result',item->'output') ELSE '{}'::jsonb END ||
      CASE WHEN item?'status' THEN '{}'::jsonb ELSE jsonb_build_object('status',CASE
        WHEN coalesce(item#>'{result,success}',item#>'{output,success}')='true' THEN 'ok'
        WHEN item->>'state' IN ('error','output-error','input-error','output-denied')
          OR coalesce(item#>'{result,success}',item#>'{output,success}')='false' THEN 'error'
        WHEN item->>'state'='output-available' OR item ?| ARRAY['result','output'] THEN 'ok'
        ELSE 'unknown' END) END
      ELSE item END ORDER BY ord)
    FROM jsonb_array_elements(tool_calls) WITH ORDINALITY t(item,ord)
  ) WHERE jsonb_typeof(tool_calls)='array'
    AND jsonb_path_exists(tool_calls,'$[*] ? (exists(@.input) || exists(@.arguments) || exists(@.output) || exists(@.state))');
  UPDATE public.message_processing_turn_snapshots SET request=nullif(agent_invocation->'request','null'),
    response=CASE WHEN jsonb_typeof(agent_invocation->'response')='object' THEN (agent_invocation->'response')-ARRAY['toolCalls','agentSteps','memorySnapshot']
                  ELSE nullif(agent_invocation->'response','null') END;
  -- TTFT was available only inside the response on some older records.
  UPDATE public.message_processing_records r SET ttft_ms=round((i.response#>>'{timings,durations,requestToFirstTextDeltaMs}')::numeric)::integer
    FROM public.message_processing_turn_snapshots i WHERE i.message_id=r.message_id AND r.ttft_ms IS NULL
      AND jsonb_typeof(i.response#>'{timings,durations,requestToFirstTextDeltaMs}')='number'
      AND (i.response#>>'{timings,durations,requestToFirstTextDeltaMs}')::numeric BETWEEN 0 AND 2147483647;
END $migration$;
SET LOCAL statement_timeout = '5min';

DROP FUNCTION IF EXISTS public.save_processing_snapshot(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.processing_guard_tools(), public.processing_accept_full_snapshot();
DROP FUNCTION IF EXISTS public.processing_read_steps(public.message_processing_records);
DROP FUNCTION IF EXISTS public.processing_read_invocation(public.message_processing_turn_snapshots);
DROP FUNCTION IF EXISTS public.processing_pack_steps(jsonb,jsonb), public.processing_tools_digest(jsonb);
ALTER TABLE public.message_processing_records DROP COLUMN IF EXISTS step_tools_v1, DROP COLUMN IF EXISTS invocation_version;
ALTER TABLE public.message_processing_turn_snapshots DROP COLUMN IF EXISTS agent_invocation, DROP COLUMN IF EXISTS write_version,
  DROP COLUMN IF EXISTS response_tools_v1, DROP COLUMN IF EXISTS superseded_invocation;
-- No historical provider exchange can be inferred from the old SDK projection.
CREATE TABLE IF NOT EXISTS public.message_processing_invocations (
  message_id text NOT NULL REFERENCES public.message_processing_records(message_id) ON DELETE CASCADE,
  id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  provider text NOT NULL,
  http_status smallint CHECK (http_status BETWEEN 100 AND 599),
  complete boolean NOT NULL,
  request_body bytea,
  response_body bytea,
  CONSTRAINT processing_model_call_pk PRIMARY KEY (message_id,id),
  CHECK ((http_status IS NULL) = (response_body IS NULL)),
  CHECK (http_status IS NOT NULL OR NOT complete)
);
CREATE INDEX IF NOT EXISTS processing_model_call_by_turn ON public.message_processing_invocations(message_id,started_at,id);
CREATE INDEX IF NOT EXISTS processing_model_call_expiry ON public.message_processing_invocations(started_at);
ALTER TABLE public.message_processing_invocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_processing_invocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.message_processing_invocations TO service_role;
DROP POLICY IF EXISTS processing_model_call_service ON public.message_processing_invocations;
CREATE POLICY processing_model_call_service ON public.message_processing_invocations TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.save_processing_snapshot(p_record jsonb, p_request jsonb, p_response jsonb, p_invocations jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  allowed constant text[] := ARRAY['message_id','chat_id','received_at','status','user_id','user_name','manager_name',
    'bot_im_id','message_preview','reply_preview','reply_segments','error','alert_type','scenario','total_duration',
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
      'manager_name','bot_im_id','message_preview','scenario','batch_id']='{}'::jsonb THEN
    conflict_action := 'DO NOTHING';
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
-- A corrected processing context invalidates its snapshot. Status-only patches
-- leave the captured request in place. A full save writes the replacement in
-- the same transaction after the parent update.
CREATE OR REPLACE FUNCTION public.discard_corrected_processing_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  DELETE FROM public.message_processing_turn_snapshots WHERE message_id=NEW.message_id;
  IF (OLD.chat_id,OLD.received_at,OLD.batch_id) IS DISTINCT FROM (NEW.chat_id,NEW.received_at,NEW.batch_id) THEN
    DELETE FROM public.message_processing_invocations WHERE message_id=NEW.message_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.discard_corrected_processing_snapshot() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS discard_corrected_processing_snapshot ON public.message_processing_records;
CREATE TRIGGER discard_corrected_processing_snapshot AFTER UPDATE OF chat_id,received_at,batch_id,tool_calls,agent_steps
ON public.message_processing_records FOR EACH ROW
WHEN ((OLD.chat_id,OLD.received_at,OLD.batch_id,OLD.tool_calls,OLD.agent_steps)
   IS DISTINCT FROM (NEW.chat_id,NEW.received_at,NEW.batch_id,NEW.tool_calls,NEW.agent_steps))
EXECUTE FUNCTION public.discard_corrected_processing_snapshot();

-- The drawer needs conversation history immediately. Load instructions, tool
-- schemas and complete transport payloads only on the request detail endpoint.
CREATE OR REPLACE FUNCTION public.processing_request_context(i public.message_processing_turn_snapshots)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path='' AS $$
DECLARE name text; source jsonb; part jsonb; context jsonb;
BEGIN
  IF jsonb_typeof(i.request) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO context FROM jsonb_each(i.request)
    WHERE key=ANY(ARRAY['messages','history','message','userMessage','content','scenario','chatId','userId','userName','contactName','candidateName','managerName','botUserId','botName','batchId']);
  FOREACH name IN ARRAY ARRAY['agentRequest','normalizedRequest','transportRequest'] LOOP
    source:=i.request->name;
    IF jsonb_typeof(source)='object' THEN
      SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO part FROM jsonb_each(source)
        WHERE key=ANY(ARRAY['messages','history','message','userMessage','content']);
      context:=context||jsonb_build_object(name,part);
    END IF;
  END LOOP;
  RETURN context;
END $$;
REVOKE ALL ON FUNCTION public.processing_request_context(public.message_processing_turn_snapshots) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.processing_request_context(public.message_processing_turn_snapshots) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_expired_agent_invocations(p_days_old integer DEFAULT 90, p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE cutoff timestamptz := now()-make_interval(days=>p_days_old); turns integer; calls integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_days_old IS NULL OR p_days_old < 1 THEN RAISE EXCEPTION 'invalid retention bounds'; END IF;
  DELETE FROM public.message_processing_turn_snapshots WHERE message_id IN (
    SELECT message_id FROM public.message_processing_turn_snapshots WHERE created_at < cutoff ORDER BY created_at LIMIT p_limit
  );
  GET DIAGNOSTICS turns = ROW_COUNT;
  DELETE FROM public.message_processing_invocations WHERE (message_id,id) IN (
    SELECT message_id,id FROM public.message_processing_invocations WHERE started_at < cutoff ORDER BY started_at LIMIT p_limit-turns
  );
  GET DIAGNOSTICS calls = ROW_COUNT;
  RETURN turns+calls;
END $$;
REVOKE ALL ON FUNCTION public.delete_expired_agent_invocations(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delete_expired_agent_invocations(integer,integer) TO service_role;
COMMENT ON TABLE public.message_processing_turn_snapshots IS '每条流水至多一份 Cake 回合上下文、SDK 消息和渠道投递摘要。';
COMMENT ON TABLE public.message_processing_invocations IS '一次模型 HTTP 请求一行，正文保留实际字节，complete 表示响应正文读取到末尾。默认保留 90 天。';
COMMENT ON FUNCTION public.delete_expired_agent_invocations(integer,integer) IS '在同一批量预算内清理过期回合快照和模型 HTTP 调用。';
COMMENT ON COLUMN public.message_processing_records.agent_steps IS '按执行顺序保存步骤元数据。tool_calls 中的 stepPosition 对应本数组的零起始位置。';
NOTIFY pgrst,'reload schema';
COMMIT;
