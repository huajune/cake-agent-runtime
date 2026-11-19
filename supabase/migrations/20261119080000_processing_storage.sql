-- Versions are optional during the rolling deploy. Existing rows and writers stay readable.
ALTER TABLE public.message_processing_records
  ADD COLUMN IF NOT EXISTS invocation_version uuid,
  ADD COLUMN IF NOT EXISTS step_tools_v1 bytea;
ALTER TABLE public.message_processing_invocations
  ADD COLUMN IF NOT EXISTS write_version uuid,
  ADD COLUMN IF NOT EXISTS response_tools_v1 bytea,
  ADD COLUMN IF NOT EXISTS superseded_invocation jsonb;

-- Only a database administrator changes these switches. A missing key means full writes.
CREATE OR REPLACE FUNCTION public.runtime_storage_enabled(p_field text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce((SELECT (value -> p_field) = 'true'::jsonb
    FROM public.system_config WHERE key = 'runtime_storage_writes'), false);
$$;
REVOKE ALL ON FUNCTION public.runtime_storage_enabled(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_storage_enabled(text) TO service_role;

CREATE OR REPLACE FUNCTION public.processing_tools_digest(p_calls jsonb)
RETURNS bytea LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = '' AS $$
  SELECT sha256(convert_to(p_calls::text, 'UTF8'));
$$;

-- A step retains its original object, index, retry metadata and position. Only ordered,
-- whole sequences that exactly match the master are representable as slice lengths.
CREATE OR REPLACE FUNCTION public.processing_pack_steps(p_steps jsonb, p_calls jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = '' AS $$
DECLARE s jsonb; n int; pos int := 0; packed jsonb := '[]'; matched jsonb;
BEGIN
  IF jsonb_typeof(p_steps) <> 'array' OR jsonb_typeof(p_calls) <> 'array'
     OR jsonb_array_length(p_calls) = 0 THEN RETURN NULL; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(p_steps) LOOP
    IF jsonb_typeof(s->'toolCalls') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    n := jsonb_array_length(s->'toolCalls');
    SELECT coalesce(jsonb_agg(p_calls->i ORDER BY i), '[]') INTO matched
      FROM generate_series(pos, pos+n-1) AS i;
    IF matched IS DISTINCT FROM s->'toolCalls' THEN RETURN NULL; END IF;
    packed := packed || jsonb_build_array(jsonb_set(s, '{toolCalls}', to_jsonb(n)));
    pos := pos+n;
  END LOOP;
  IF pos <> jsonb_array_length(p_calls) THEN RETURN NULL; END IF;
  RETURN packed;
END $$;

CREATE OR REPLACE FUNCTION public.processing_read_steps(r public.message_processing_records)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = '' AS $$
DECLARE s jsonb; n int; pos int := 0; expanded jsonb := '[]'; calls jsonb;
BEGIN
  IF r.step_tools_v1 IS NULL THEN RETURN r.agent_steps; END IF;
  IF r.step_tools_v1 IS DISTINCT FROM public.processing_tools_digest(r.tool_calls)
     OR jsonb_typeof(r.agent_steps) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'processing_steps_reference_mismatch';
  END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(r.agent_steps) LOOP
    n := (s->>'toolCalls')::integer;
    IF n IS NULL OR n < 0 OR n > jsonb_array_length(r.tool_calls)-pos THEN
      RAISE EXCEPTION 'processing_steps_slice_mismatch';
    END IF;
    SELECT coalesce(jsonb_agg(r.tool_calls->i ORDER BY i), '[]') INTO calls
      FROM generate_series(pos, pos+n-1) AS i;
    expanded := expanded || jsonb_build_array(jsonb_set(s,'{toolCalls}',calls));
    pos := pos+n;
  END LOOP;
  IF pos <> jsonb_array_length(r.tool_calls) THEN RAISE EXCEPTION 'processing_steps_length_mismatch'; END IF;
  RETURN expanded;
END $$;

CREATE OR REPLACE FUNCTION public.processing_read_invocation(i public.message_processing_invocations)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT SECURITY INVOKER SET search_path = '' AS $$
DECLARE calls jsonb; ver uuid;
BEGIN
  IF i.superseded_invocation IS NOT NULL THEN RETURN NULL; END IF;
  IF i.response_tools_v1 IS NULL THEN RETURN i.agent_invocation; END IF;
  SELECT tool_calls, invocation_version INTO calls, ver FROM public.message_processing_records
    WHERE message_id=i.message_id;
  IF ver IS NULL OR ver IS DISTINCT FROM i.write_version
     OR i.response_tools_v1 IS DISTINCT FROM public.processing_tools_digest(calls) THEN
    RAISE EXCEPTION 'processing_invocation_reference_mismatch';
  END IF;
  RETURN jsonb_set(i.agent_invocation, '{response,toolCalls}', calls);
END $$;

-- The same trigger covers scalar patches, corrections and legacy direct updates.
-- Preserve the exact previous step contents when only their source was corrected.
CREATE OR REPLACE FUNCTION public.processing_guard_tools() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF OLD.step_tools_v1 IS NOT NULL AND NEW.step_tools_v1 IS NOT DISTINCT FROM OLD.step_tools_v1 THEN
    IF NEW.agent_steps IS NOT DISTINCT FROM OLD.agent_steps THEN
      IF NEW.tool_calls IS DISTINCT FROM OLD.tool_calls THEN
        NEW.agent_steps := public.processing_read_steps(OLD);
        NEW.step_tools_v1 := NULL;
      END IF;
    ELSIF jsonb_typeof(NEW.agent_steps #> '{0,toolCalls}') IS DISTINCT FROM 'number' THEN
      -- A pre-upgrade writer replaced the step array without a codec marker.
      NEW.step_tools_v1 := NULL;
    END IF;
  END IF;
  IF (NEW.tool_calls IS DISTINCT FROM OLD.tool_calls OR NEW.chat_id IS DISTINCT FROM OLD.chat_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR (NEW.agent_steps IS DISTINCT FROM OLD.agent_steps
       AND public.processing_read_steps(NEW) IS DISTINCT FROM public.processing_read_steps(OLD)))
     AND NEW.invocation_version IS NOT DISTINCT FROM OLD.invocation_version THEN
    -- Keep the previous exact snapshot to its original expiry. Never attach it to a corrected master.
    IF EXISTS (SELECT 1 FROM public.message_processing_invocations i WHERE i.message_id=OLD.message_id
      AND i.response_tools_v1 IS NOT NULL AND (i.write_version IS DISTINCT FROM OLD.invocation_version
        OR i.response_tools_v1 IS DISTINCT FROM public.processing_tools_digest(OLD.tool_calls))) THEN
      RAISE EXCEPTION 'processing_invocation_reference_mismatch';
    END IF;
    UPDATE public.message_processing_invocations SET agent_invocation='null'::jsonb,
      superseded_invocation=CASE WHEN response_tools_v1 IS NULL THEN agent_invocation
        ELSE jsonb_set(agent_invocation,'{response,toolCalls}',OLD.tool_calls) END,
      response_tools_v1=NULL WHERE message_id=OLD.message_id AND superseded_invocation IS NULL;
    IF OLD.agent_invocation IS NOT NULL THEN
      INSERT INTO public.message_processing_invocations(message_id,agent_invocation,superseded_invocation,created_at)
        VALUES(OLD.message_id,'null'::jsonb,OLD.agent_invocation,OLD.received_at) ON CONFLICT DO NOTHING;
      NEW.agent_invocation := NULL;
    END IF;
    NEW.invocation_version := gen_random_uuid();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS processing_guard_tools ON public.message_processing_records;
CREATE TRIGGER processing_guard_tools BEFORE UPDATE OF tool_calls,agent_steps,chat_id,received_at,batch_id
  ON public.message_processing_records FOR EACH ROW EXECUTE FUNCTION public.processing_guard_tools();

-- A rolling legacy writer supplies a full JSON value and no generation metadata.
CREATE OR REPLACE FUNCTION public.processing_accept_full_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.write_version IS NOT DISTINCT FROM OLD.write_version
     AND NEW.superseded_invocation IS NOT DISTINCT FROM OLD.superseded_invocation THEN
    NEW.write_version:=NULL; NEW.response_tools_v1:=NULL; NEW.superseded_invocation:=NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS processing_accept_full_snapshot ON public.message_processing_invocations;
CREATE TRIGGER processing_accept_full_snapshot BEFORE UPDATE OF agent_invocation ON public.message_processing_invocations
  FOR EACH ROW EXECUTE FUNCTION public.processing_accept_full_snapshot();

CREATE OR REPLACE FUNCTION public.save_processing_snapshot(p_record jsonb, p_invocation jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  permitted constant text[] := ARRAY['message_id','chat_id','received_at','status','user_id','user_name','manager_name',
    'bot_im_id','message_preview','reply_preview','reply_segments','error','alert_type','scenario','total_duration',
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
END $$;
REVOKE ALL ON FUNCTION public.processing_read_steps(public.message_processing_records),
  public.processing_read_invocation(public.message_processing_invocations),
  public.save_processing_snapshot(jsonb,jsonb),public.processing_guard_tools() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.processing_read_steps(public.message_processing_records),
  public.processing_read_invocation(public.message_processing_invocations),
  public.save_processing_snapshot(jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.processing_pack_steps(jsonb,jsonb),public.processing_tools_digest(jsonb),
  public.processing_accept_full_snapshot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.processing_pack_steps(jsonb,jsonb),public.processing_tools_digest(jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
