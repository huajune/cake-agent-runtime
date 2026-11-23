-- Source times are separate from processing/ingestion times. A replay keeps its original evidence.
ALTER TABLE public.message_processing_records
  ADD COLUMN source_occurred_at timestamptz,
  ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.message_processing_invocations ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.agent_execution_events ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.guardrail_review_records ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.handoff_events ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.reengagement_touch_records ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.ops_events ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.user_activity ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.daily_ops_report ADD COLUMN tenant_id text REFERENCES public.tenants(id);

-- All these producers use the primary Stride connection. A new connection must carry
-- its own connection identity through ingestion before it can contribute to these tables.
CREATE FUNCTION public.stride_business_tenant(p_bot text, p_at timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT public.hosting_tenant_at('stride-primary', p_bot, NULL, p_at)
$$;

CREATE FUNCTION public.assign_processing_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.source_occurred_at := coalesce(OLD.source_occurred_at,NEW.source_occurred_at);
    IF OLD.bot_im_id IS NOT NULL THEN NEW.bot_im_id := OLD.bot_im_id; END IF;
  END IF;
  -- Some entry points have an exact source chat. Never use the worker's clock to
  -- attribute an old batch that lacks an original source timestamp.
  IF NEW.source_occurred_at IS NULL THEN
    SELECT c.timestamp INTO NEW.source_occurred_at FROM chat_messages c
      WHERE c.message_id=NEW.message_id AND c.im_bot_id=NEW.bot_im_id
        AND c.hosting_connection_id='stride-primary';
  END IF;
  NEW.tenant_id := stride_business_tenant(NEW.bot_im_id,NEW.source_occurred_at);
  RETURN NEW;
END $$;
CREATE TRIGGER assign_processing_tenant BEFORE INSERT OR UPDATE OF tenant_id,bot_im_id,source_occurred_at
 ON public.message_processing_records FOR EACH ROW EXECUTE FUNCTION public.assign_processing_tenant();

CREATE FUNCTION public.assign_business_event_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='ops_events' THEN
    NEW.tenant_id := stride_business_tenant(NEW.bot_im_id,NEW.occurred_at);
  ELSIF TG_TABLE_NAME='handoff_events' THEN
    NEW.tenant_id := stride_business_tenant(NEW.bot_im_id,NEW.created_at);
  ELSE
    IF TG_OP='UPDATE' THEN
      NEW.anchor_at := coalesce(OLD.anchor_at,NEW.anchor_at);
      NEW.bot_im_id := coalesce(OLD.bot_im_id,NEW.bot_im_id);
    END IF;
    NEW.tenant_id := stride_business_tenant(NEW.bot_im_id,NEW.anchor_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assign_ops_tenant BEFORE INSERT OR UPDATE OF tenant_id,bot_im_id,occurred_at
 ON public.ops_events FOR EACH ROW EXECUTE FUNCTION public.assign_business_event_tenant();
CREATE TRIGGER assign_touch_tenant BEFORE INSERT OR UPDATE OF tenant_id,bot_im_id,anchor_at
 ON public.reengagement_touch_records FOR EACH ROW EXECUTE FUNCTION public.assign_business_event_tenant();
CREATE TRIGGER assign_handoff_tenant BEFORE INSERT OR UPDATE OF tenant_id,bot_im_id,created_at
 ON public.handoff_events FOR EACH ROW EXECUTE FUNCTION public.assign_business_event_tenant();

-- An execution event can arrive before the processing snapshot. Serialize by the
-- stable trace identity and propagate the parent's stamp in either arrival order.
CREATE FUNCTION public.inherit_processing_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE trace text;
BEGIN
  IF TG_TABLE_NAME='message_processing_invocations' THEN trace:=NEW.message_id;
  ELSE trace:=NEW.trace_id; END IF;
  IF trace IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cake.trace.'||trace,0));
    SELECT r.tenant_id INTO NEW.tenant_id FROM message_processing_records r WHERE r.message_id=trace;
  ELSE NEW.tenant_id:=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inherit_invocation_tenant BEFORE INSERT OR UPDATE OF message_id,tenant_id
 ON public.message_processing_invocations FOR EACH ROW EXECUTE FUNCTION public.inherit_processing_tenant();
CREATE TRIGGER inherit_execution_tenant BEFORE INSERT OR UPDATE OF trace_id,tenant_id
 ON public.agent_execution_events FOR EACH ROW EXECUTE FUNCTION public.inherit_processing_tenant();
CREATE TRIGGER inherit_review_tenant BEFORE INSERT OR UPDATE OF trace_id,tenant_id
 ON public.guardrail_review_records FOR EACH ROW EXECUTE FUNCTION public.inherit_processing_tenant();
CREATE FUNCTION public.propagate_processing_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.trace.'||NEW.message_id,0));
  UPDATE agent_execution_events SET tenant_id=NEW.tenant_id WHERE trace_id=NEW.message_id AND tenant_id IS DISTINCT FROM NEW.tenant_id;
  UPDATE guardrail_review_records SET tenant_id=NEW.tenant_id WHERE trace_id=NEW.message_id AND tenant_id IS DISTINCT FROM NEW.tenant_id;
  UPDATE message_processing_invocations SET tenant_id=NEW.tenant_id WHERE message_id=NEW.message_id AND tenant_id IS DISTINCT FROM NEW.tenant_id;
  RETURN NEW;
END $$;
CREATE TRIGGER propagate_processing_tenant AFTER INSERT OR UPDATE OF tenant_id,bot_im_id,source_occurred_at
 ON public.message_processing_records FOR EACH ROW EXECUTE FUNCTION public.propagate_processing_tenant();

ALTER TABLE public.user_activity DROP CONSTRAINT user_activity_chat_id_activity_date_key,
  ADD UNIQUE NULLS NOT DISTINCT (tenant_id,chat_id,activity_date);
ALTER TABLE public.daily_ops_report DROP CONSTRAINT daily_ops_report_unique,
  ADD UNIQUE NULLS NOT DISTINCT (tenant_id,corp_id,report_date,bot_im_id);

CREATE INDEX processing_tenant_received_idx ON public.message_processing_records(tenant_id,received_at DESC,message_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX touch_tenant_created_idx ON public.reengagement_touch_records(tenant_id,created_at DESC,touch_key) WHERE tenant_id IS NOT NULL;
CREATE INDEX ops_event_tenant_day_idx ON public.ops_events(tenant_id,report_date,bot_im_id) WHERE tenant_id IS NOT NULL;
REVOKE ALL ON FUNCTION public.stride_business_tenant(text,timestamptz), public.assign_processing_tenant(),
  public.assign_business_event_tenant(),public.inherit_processing_tenant(),public.propagate_processing_tenant() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stride_business_tenant(text,timestamptz), public.assign_processing_tenant(),
  public.assign_business_event_tenant(),public.inherit_processing_tenant(),public.propagate_processing_tenant() TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_ops_event(p_corp_id text, p_event_name text, p_idempotency_key text, p_occurred_at timestamp with time zone DEFAULT now(), p_bot_im_id text DEFAULT NULL::text, p_manager_name text DEFAULT NULL::text, p_group_name text DEFAULT NULL::text, p_source_channel text DEFAULT NULL::text, p_user_id text DEFAULT NULL::text, p_chat_id text DEFAULT NULL::text, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_report_date date;
  v_tenant text;
  v_inserted_count int := 0;
  v_column text;
  v_summary_line text;
  v_brand text;
BEGIN
  -- report_date 由 RPC 内部按上海时区计算
  v_report_date := (p_occurred_at AT TIME ZONE 'Asia/Shanghai')::date;

  -- 写底账（幂等：重复 idempotency_key 被 UNIQUE 拒绝）
  INSERT INTO ops_events (
    corp_id, event_name, occurred_at, report_date,
    bot_im_id, manager_name, group_name, source_channel,
    user_id, chat_id, idempotency_key, payload
  )
  VALUES (
    p_corp_id, p_event_name, p_occurred_at, v_report_date,
    p_bot_im_id, p_manager_name, p_group_name, p_source_channel,
    p_user_id, p_chat_id, p_idempotency_key, p_payload
  )
  ON CONFLICT (corp_id, event_name, idempotency_key) DO NOTHING RETURNING tenant_id INTO v_tenant;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  -- 仅当真正插入（非冲突跳过）且事件可投影且有 bot 归属时，才投影日报
  v_column := ops_event_projection_column(p_event_name);

  IF v_inserted_count > 0 AND v_column IS NOT NULL AND p_bot_im_id IS NOT NULL THEN
    -- 确保当天该 bot 的投影行存在
    INSERT INTO daily_ops_report (tenant_id, corp_id, report_date, bot_im_id, manager_name, group_name)
    VALUES (v_tenant, p_corp_id, v_report_date, p_bot_im_id, p_manager_name, p_group_name)
    ON CONFLICT (tenant_id, corp_id, report_date, bot_im_id) DO UPDATE
      SET manager_name = COALESCE(daily_ops_report.manager_name, EXCLUDED.manager_name),
          group_name   = COALESCE(daily_ops_report.group_name, EXCLUDED.group_name);

    -- 动态 +1 对应计数列
    EXECUTE format(
      'UPDATE daily_ops_report SET %I = %I + 1 '
      'WHERE corp_id = $1 AND report_date = $2 AND bot_im_id = $3 AND tenant_id IS NOT DISTINCT FROM $4',
      v_column, v_column
    ) USING p_corp_id, v_report_date, p_bot_im_id, v_tenant;

    -- booking.succeeded 衍生明细：candidate_summary（追加一行）+ booking_brands（去重追加）
    IF p_event_name = 'booking.succeeded' AND p_payload IS NOT NULL THEN
      v_summary_line := trim(
        COALESCE(p_payload->>'candidate_name', '') || ' ' || COALESCE(p_payload->>'phone', '')
      );
      IF v_summary_line <> '' THEN
        UPDATE daily_ops_report
        SET candidate_summary = CASE
              WHEN candidate_summary IS NULL OR candidate_summary = '' THEN v_summary_line
              ELSE candidate_summary || E'\n' || v_summary_line
            END
        WHERE corp_id = p_corp_id AND report_date = v_report_date AND bot_im_id = p_bot_im_id AND tenant_id IS NOT DISTINCT FROM v_tenant;
      END IF;

      v_brand := p_payload->>'brand_name';
      IF v_brand IS NOT NULL AND v_brand <> '' THEN
        UPDATE daily_ops_report
        SET booking_brands = (
          SELECT ARRAY(
            SELECT DISTINCT b
            FROM unnest(COALESCE(booking_brands, '{}'::text[]) || ARRAY[v_brand]) AS b
          )
        )
        WHERE corp_id = p_corp_id AND report_date = v_report_date AND bot_im_id = p_bot_im_id AND tenant_id IS NOT DISTINCT FROM v_tenant;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'inserted', v_inserted_count > 0,
    'report_date', v_report_date,
    'projected_column', v_column
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_user_activity(p_chat_id text, p_od_id text DEFAULT NULL::text, p_od_name text DEFAULT NULL::text, p_message_count integer DEFAULT 1, p_token_usage integer DEFAULT 0, p_active_at timestamp with time zone DEFAULT now(), p_bot_user_id text DEFAULT NULL::text, p_im_bot_id text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_date date := (p_active_at AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  INSERT INTO user_activity (
    tenant_id,chat_id,
    activity_date,
    od_id,
    od_name,
    message_count,
    token_usage,
    bot_user_id,
    im_bot_id,
    first_active_at,
    last_active_at,
    updated_at
  )
  VALUES (
    public.stride_business_tenant(p_im_bot_id,p_active_at),p_chat_id,
    v_date,
    p_od_id,
    p_od_name,
    p_message_count,
    p_token_usage,
    p_bot_user_id,
    p_im_bot_id,
    p_active_at,
    p_active_at,
    now()
  )
  ON CONFLICT (tenant_id,chat_id, activity_date) DO UPDATE SET
    od_id          = COALESCE(EXCLUDED.od_id, user_activity.od_id),
    od_name        = COALESCE(EXCLUDED.od_name, user_activity.od_name),
    message_count  = user_activity.message_count + EXCLUDED.message_count,
    token_usage    = user_activity.token_usage + EXCLUDED.token_usage,
    bot_user_id    = COALESCE(EXCLUDED.bot_user_id, user_activity.bot_user_id),
    im_bot_id      = COALESCE(EXCLUDED.im_bot_id, user_activity.im_bot_id),
    first_active_at = LEAST(user_activity.first_active_at, EXCLUDED.first_active_at),
    last_active_at  = GREATEST(user_activity.last_active_at, EXCLUDED.last_active_at),
    updated_at      = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_processing_snapshot(p_record jsonb, p_invocation jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  permitted constant text[] := ARRAY['message_id','chat_id','received_at','status','user_id','user_name','manager_name',
    'bot_im_id','source_occurred_at','message_preview','reply_preview','reply_segments','error','alert_type','scenario','total_duration',
    'queue_duration','prep_duration','ai_duration','ttft_ms','send_duration','token_usage','is_fallback','fallback_success',
    'batch_id','tool_calls','agent_steps','anomaly_flags','guardrail_input','guardrail_output','memory_snapshot','post_processing_status'];
  packed jsonb; col_list text; assignments text; calls jsonb; digest bytea; ver uuid;
BEGIN
  IF jsonb_typeof(p_record) IS DISTINCT FROM 'object' OR NOT (p_record ?& ARRAY['message_id','chat_id','received_at','status'])
     OR (p_record - permitted) <> '{}'::jsonb THEN RAISE EXCEPTION 'invalid processing record'; END IF;
  -- Only provided fields participate, preserving PostgREST defaults and partial-update semantics.
  IF p_invocation IS NOT NULL AND p_invocation <> 'null'::jsonb THEN
    ver := gen_random_uuid();
    p_record := p_record || jsonb_build_object('invocation_version',ver);
  END IF;
  IF p_record ? 'agent_steps' THEN
    IF public.runtime_storage_enabled('steps') THEN
      packed := public.processing_pack_steps(p_record->'agent_steps',p_record->'tool_calls');
    END IF;
    IF packed IS NOT NULL AND pg_column_size(packed)+36 < pg_column_size(p_record->'agent_steps') THEN
      p_record := p_record || jsonb_build_object('agent_steps',packed,
        'step_tools_v1',public.processing_tools_digest(p_record->'tool_calls'));
    ELSE
      p_record := p_record || jsonb_build_object('step_tools_v1',NULL);
    END IF;
  END IF;
  SELECT string_agg(format('%I',k),',' ORDER BY k),
         string_agg(format('%1$I=excluded.%1$I',k),',' ORDER BY k) FILTER (WHERE k <> 'message_id')
    INTO col_list, assignments FROM jsonb_object_keys(p_record) AS k;
  EXECUTE format('INSERT INTO public.message_processing_records (%1$s)
    SELECT %1$s FROM jsonb_populate_record(NULL::public.message_processing_records,$1)
    ON CONFLICT(message_id) DO UPDATE SET %2$s RETURNING tool_calls',col_list,assignments)
    INTO calls USING p_record;
  IF ver IS NOT NULL THEN
    IF public.runtime_storage_enabled('response_tools') AND jsonb_typeof(calls)='array'
       AND p_record->'tool_calls'=calls AND p_invocation#>'{response,toolCalls}'=calls
       AND pg_column_size(calls)>64 THEN
      digest := public.processing_tools_digest(calls);
      p_invocation := p_invocation #- '{response,toolCalls}';
    END IF;
    INSERT INTO public.message_processing_invocations(message_id,agent_invocation,write_version,response_tools_v1)
      VALUES(p_record->>'message_id',p_invocation,ver,digest)
      ON CONFLICT(message_id) DO UPDATE SET agent_invocation=excluded.agent_invocation,
        write_version=excluded.write_version,response_tools_v1=excluded.response_tools_v1,superseded_invocation=NULL;
  END IF;
  RETURN true;
END $function$;

-- Preserve array order for merged input. A stored chat is stronger evidence than a
-- lookup by Bot alone, including a stored unresolved or conflicting source.
CREATE FUNCTION public.hosting_event_tenants(p_connection_id text,p_events jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_agg(CASE
    WHEN c.id IS NOT NULL THEN
      CASE WHEN c.im_bot_id=e.item->>'bot' AND c.hosting_connection_id=p_connection_id AND c.timestamp=(e.item->>'at')::timestamptz
        THEN (SELECT v.tenant_id FROM tenant_visible_chat_messages v WHERE v.message_id=c.message_id) END
    ELSE hosting_tenant_at(p_connection_id,e.item->>'bot',e.item->>'group_id',(e.item->>'at')::timestamptz)
    END ORDER BY e.ord),'[]'::jsonb)
  FROM jsonb_array_elements(p_events) WITH ORDINALITY e(item,ord)
  LEFT JOIN chat_messages c ON c.message_id=e.item->>'message_id'
$$;
REVOKE ALL ON FUNCTION public.hosting_event_tenants(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hosting_event_tenants(text,jsonb) TO service_role;

-- One intake increment and one token increment per logical event. Retried workers
-- keep the original dimensions and cannot add to either tenant a second time.
CREATE TABLE public.user_activity_events (
  event_key text PRIMARY KEY, chat_id text NOT NULL, bot_im_id text, occurred_at timestamptz NOT NULL,
  tenant_id text REFERENCES public.tenants(id), message_count integer NOT NULL, token_usage integer NOT NULL
);
ALTER TABLE public.user_activity_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_activity_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.user_activity_events TO service_role;
CREATE INDEX user_activity_events_bot_time_idx ON public.user_activity_events(bot_im_id,occurred_at);
CREATE FUNCTION public.record_user_activity(
  p_event_key text,p_chat_id text,p_od_id text,p_od_name text,p_message_count integer,p_token_usage integer,
  p_active_at timestamptz,p_bot_user_id text,p_im_bot_id text
) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('cake.hosting.stride-primary',0));
  INSERT INTO user_activity_events(event_key,chat_id,bot_im_id,occurred_at,tenant_id,message_count,token_usage)
    VALUES(p_event_key,p_chat_id,p_im_bot_id,p_active_at,stride_business_tenant(p_im_bot_id,p_active_at),p_message_count,p_token_usage)
    ON CONFLICT(event_key) DO NOTHING;
  IF FOUND THEN
    PERFORM upsert_user_activity(p_chat_id,p_od_id,p_od_name,p_message_count,p_token_usage,p_active_at,p_bot_user_id,p_im_bot_id);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.record_user_activity(text,text,text,text,int,int,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_user_activity(text,text,text,text,int,int,timestamptz,text,text) TO service_role;

-- Older queued jobs may predate channel snapshots. Accept a single proven
-- historical Bot, and leave a missing or ambiguous account unresolved.
CREATE FUNCTION public.hosting_session_bot(p_chat text,p_at timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp SET statement_timeout='3s' AS $$
  SELECT CASE WHEN count(*)=1 THEN min(im_bot_id) END FROM (
    SELECT DISTINCT im_bot_id FROM tenant_visible_chat_messages WHERE chat_id=p_chat
      AND hosting_connection_id='stride-primary' AND timestamp<=p_at AND im_bot_id IS NOT NULL LIMIT 2
  ) candidates
$$;
REVOKE ALL ON FUNCTION public.hosting_session_bot(text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hosting_session_bot(text,timestamptz) TO service_role;
