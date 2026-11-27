-- Keep the raw external corp/user/Bot identity. The same relation may have
-- separate profiles before and after a tenant handover. NULL is the legacy partition.
ALTER TABLE public.agent_long_term_memories ADD COLUMN tenant_id text REFERENCES public.tenants(id);
ALTER TABLE public.agent_long_term_memories DROP CONSTRAINT agent_long_term_memories_relation_unique;
DROP INDEX public.agent_long_term_memories_legacy_relation_unique;
ALTER TABLE public.agent_long_term_memories ADD UNIQUE NULLS NOT DISTINCT (tenant_id,corp_id,user_id,bot_user_id);

CREATE OR REPLACE FUNCTION public.tenant_upsert_long_term_profile_facts(p_tenant_id text, p_corp_id text, p_user_id text, p_bot_user_id text, p_profile_facts jsonb, p_message_metadata jsonb DEFAULT NULL::jsonb, p_preference_facts jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  merged_profile jsonb; merged_intent jsonb; old_fact jsonb; incoming jsonb; k text; dependent text;
  written text[] := '{}'; skipped text[] := '{}'; preference_written boolean := false;
  profile_keys text[] := ARRAY['name','phone','gender','age','is_student','education','has_health_certificate','height','weight'];
  intent_keys text[] := ARRAY['city','district','location','brands','position','schedule','salary','labor_form','schedule_constraint','delayed_intent','available_after'];
BEGIN
  IF NULLIF(btrim(p_bot_user_id),'') IS NULL THEN RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId'; END IF;
  INSERT INTO public.agent_long_term_memories(tenant_id,corp_id,user_id,bot_user_id,semantic_profile,episodic_session_summaries)
    VALUES(p_tenant_id,p_corp_id,p_user_id,p_bot_user_id,default_long_term_profile_facts(),default_long_term_summary_data())
    ON CONFLICT(tenant_id,corp_id,user_id,bot_user_id) DO NOTHING;
  SELECT coalesce(semantic_profile,default_long_term_profile_facts()),coalesce(semantic_job_intent,'{}')
    INTO merged_profile,merged_intent FROM public.agent_long_term_memories
    WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id=p_bot_user_id FOR UPDATE;
  FOREACH k IN ARRAY profile_keys LOOP
    incoming := public.normalize_memory_fact(k,p_profile_facts->k);
    IF incoming IS NULL OR incoming->'value'='null'::jsonb THEN CONTINUE; END IF;
    IF NOT(incoming ? 'updatedAt') THEN incoming := jsonb_set(incoming,'{updatedAt}',to_jsonb(now())); END IF;
    old_fact := merged_profile->k;
    IF (old_fact->>'confidence'='high' AND long_term_profile_confidence_rank(coalesce(incoming->>'confidence','unknown'))<3)
       OR public.memory_fact_timestamp(incoming)<public.memory_fact_timestamp(old_fact) THEN
      skipped := array_append(skipped,k); CONTINUE;
    END IF;
    merged_profile := jsonb_set(merged_profile,ARRAY[k],incoming); written := array_append(written,k);
  END LOOP;
  FOREACH k IN ARRAY intent_keys LOOP
    incoming := public.normalize_memory_fact(k,p_preference_facts->k);
    IF incoming IS NULL THEN CONTINUE; END IF;
    IF NOT(incoming ? 'updatedAt') THEN incoming := jsonb_set(incoming,'{updatedAt}',to_jsonb(now())); END IF;
    old_fact := merged_intent->k;
    IF public.memory_fact_timestamp(incoming)<public.memory_fact_timestamp(old_fact) THEN CONTINUE; END IF;
    -- 换城市后旧区域/商圈不能继承；同时间的新区域补丁在后续循环正常写入。
    IF k='city' AND old_fact->'value' IS DISTINCT FROM incoming->'value' THEN
      FOREACH dependent IN ARRAY ARRAY['district','location'] LOOP
        IF public.memory_fact_timestamp(merged_intent->dependent)<=public.memory_fact_timestamp(incoming) THEN
          merged_intent := jsonb_set(merged_intent,ARRAY[dependent],jsonb_set(incoming,'{value}','null'));
        END IF;
      END LOOP;
    END IF;
    merged_intent := jsonb_set(merged_intent,ARRAY[k],incoming); preference_written := true;
  END LOOP;
  IF cardinality(written)>0 OR preference_written OR p_message_metadata IS NOT NULL THEN
    UPDATE public.agent_long_term_memories SET semantic_profile=merged_profile,semantic_job_intent=merged_intent,
      message_metadata=CASE WHEN jsonb_typeof(p_message_metadata)='object' THEN coalesce(message_metadata,'{}')||jsonb_strip_nulls(p_message_metadata) ELSE message_metadata END,
      updated_at=now() WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id=p_bot_user_id;
  END IF;
  RETURN jsonb_build_object('written_fields',written,'skipped_fields',skipped,'preference_written',preference_written);
END;
$function$;
REVOKE ALL ON FUNCTION public.tenant_upsert_long_term_profile_facts(text,text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_upsert_long_term_profile_facts(text,text,text,text,jsonb,jsonb,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.upsert_long_term_profile_facts(p_corp_id text, p_user_id text, p_bot_user_id text, p_profile_facts jsonb, p_message_metadata jsonb DEFAULT NULL::jsonb, p_preference_facts jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT public.tenant_upsert_long_term_profile_facts(NULL,p_corp_id,p_user_id,p_bot_user_id,p_profile_facts,p_message_metadata,p_preference_facts)
$$;
REVOKE ALL ON FUNCTION public.upsert_long_term_profile_facts(text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_long_term_profile_facts(text,text,text,jsonb,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_upsert_booking_profile_facts(p_tenant_id text, p_corp_id text, p_user_id text, p_bot_user_id text, p_profile_facts jsonb, p_message_metadata jsonb DEFAULT NULL::jsonb, p_preference_facts jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  existing jsonb;
  filtered jsonb := coalesce(p_profile_facts,'{}'::jsonb);
  field record;
BEGIN
  IF nullif(btrim(p_bot_user_id),'') IS NULL THEN RAISE EXCEPTION 'stable account required'; END IF;
  INSERT INTO public.agent_long_term_memories(tenant_id,corp_id,user_id,bot_user_id)
    VALUES(p_tenant_id,p_corp_id,p_user_id,p_bot_user_id) ON CONFLICT(tenant_id,corp_id,user_id,bot_user_id) DO NOTHING;
  SELECT semantic_profile INTO existing FROM public.agent_long_term_memories
    WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id=p_bot_user_id FOR UPDATE;
  FOR field IN SELECT key,value FROM jsonb_each(filtered) LOOP
    IF (existing->field.key->>'updatedAt')::timestamptz >= (field.value->>'updatedAt')::timestamptz THEN
      filtered := filtered-field.key;
    END IF;
  END LOOP;
  RETURN public.tenant_upsert_long_term_profile_facts(p_tenant_id,p_corp_id,p_user_id,p_bot_user_id,filtered,p_message_metadata,p_preference_facts);
END;
$function$;
REVOKE ALL ON FUNCTION public.tenant_upsert_booking_profile_facts(text,text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_upsert_booking_profile_facts(text,text,text,text,jsonb,jsonb,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.upsert_booking_profile_facts(p_corp_id text, p_user_id text, p_bot_user_id text, p_profile_facts jsonb, p_message_metadata jsonb DEFAULT NULL::jsonb, p_preference_facts jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT public.tenant_upsert_booking_profile_facts(NULL,p_corp_id,p_user_id,p_bot_user_id,p_profile_facts,p_message_metadata,p_preference_facts)
$$;
REVOKE ALL ON FUNCTION public.upsert_booking_profile_facts(text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_booking_profile_facts(text,text,text,jsonb,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_append_long_term_summary_atomic(p_tenant_id text, p_corp_id text, p_user_id text, p_bot_user_id text, p_entry jsonb, p_last_settled_message_at text DEFAULT NULL::text, p_max_session_summaries integer DEFAULT 20, p_session_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  existing_summary jsonb;
  existing_watermarks jsonb;
  episodes_arr jsonb := '[]'::jsonb;
  legacy_recent jsonb := '[]'::jsonb;
  legacy_archive jsonb := '[]'::jsonb;
  legacy_by_session jsonb := '{}'::jsonb;
  current_by_session jsonb := '{}'::jsonb;
  legacy_fallback text;
  current_fallback text;
  existing_session_watermark text;
  episode_count integer;
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;
  IF p_max_session_summaries < 1 THEN
    RAISE EXCEPTION 'p_max_session_summaries must be positive';
  END IF;
  IF jsonb_typeof(p_entry) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'p_entry must be a json object';
  END IF;

  INSERT INTO public.agent_long_term_memories (
    tenant_id,corp_id,
    user_id,
    bot_user_id,
    semantic_profile,
    episodic_session_summaries,
    consolidation_watermarks
  )
  VALUES (
    p_tenant_id,p_corp_id,
    p_user_id,
    p_bot_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data(),
    default_consolidation_watermarks()
  )
  ON CONFLICT(tenant_id,corp_id,user_id,bot_user_id) DO NOTHING;

  SELECT
    COALESCE(episodic_session_summaries, default_long_term_summary_data()),
    COALESCE(consolidation_watermarks, default_consolidation_watermarks())
  INTO existing_summary, existing_watermarks
  FROM public.agent_long_term_memories
  WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
  FOR UPDATE;

  IF jsonb_typeof(existing_summary) = 'array' THEN
    episodes_arr := existing_summary;
  ELSE
    -- 旧 recent 是新到旧，反转为裸数组的旧到新顺序。
    IF jsonb_typeof(existing_summary -> 'recent') = 'array' THEN
      SELECT COALESCE(jsonb_agg(item ORDER BY ordinal DESC), '[]'::jsonb)
      INTO legacy_recent
      FROM jsonb_array_elements(existing_summary -> 'recent')
        WITH ORDINALITY AS recent_item(item, ordinal)
      WHERE jsonb_typeof(item) = 'object';
    END IF;

    -- 旧 archive 只有摘要文本，没有逐段标识符；补空标识符保持 SummaryEntry 形状。
    IF jsonb_typeof(existing_summary -> 'archive') = 'string' THEN
      IF NULLIF(BTRIM(existing_summary ->> 'archive'), '') IS NOT NULL THEN
        legacy_archive := jsonb_build_array(jsonb_build_object(
          'summary', existing_summary ->> 'archive',
          'sessionId', '',
          'startTime', '',
          'endTime', ''
        ));
      END IF;
    ELSIF jsonb_typeof(existing_summary -> 'archive') = 'array' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'summary', segment #>> '{}',
            'sessionId', '',
            'startTime', '',
            'endTime', ''
          )
          ORDER BY ordinal
        ),
        '[]'::jsonb
      )
      INTO legacy_archive
      FROM jsonb_array_elements(existing_summary -> 'archive')
        WITH ORDINALITY AS archive_item(segment, ordinal)
      WHERE jsonb_typeof(segment) = 'string'
        AND NULLIF(BTRIM(segment #>> '{}'), '') IS NOT NULL;
    END IF;

    episodes_arr := legacy_archive || legacy_recent;
  END IF;

  IF jsonb_typeof(existing_summary -> 'lastSettledBySession') = 'object' THEN
    legacy_by_session := existing_summary -> 'lastSettledBySession';
  END IF;
  IF jsonb_typeof(existing_watermarks -> 'bySession') = 'object' THEN
    current_by_session := existing_watermarks -> 'bySession';
  END IF;
  legacy_fallback := NULLIF(existing_summary ->> 'lastSettledMessageAt', '');
  current_fallback := NULLIF(existing_watermarks ->> 'lastSettledMessageAt', '');
  existing_watermarks := jsonb_build_object(
    'bySession', legacy_by_session || current_by_session,
    'lastSettledMessageAt', COALESCE(current_fallback, legacy_fallback)
  );

  -- 同一 session 的相同/更旧边界不重复追加；并发任务也由行锁下的水位判定挡住。
  IF p_session_id IS NOT NULL AND p_last_settled_message_at IS NOT NULL THEN
    existing_session_watermark := existing_watermarks #>> ARRAY['bySession', p_session_id];
    IF existing_session_watermark IS NOT NULL
       AND existing_session_watermark::timestamptz >= p_last_settled_message_at::timestamptz
    THEN
      episode_count := jsonb_array_length(episodes_arr);
      IF episode_count > p_max_session_summaries THEN
        SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
        INTO episodes_arr
        FROM jsonb_array_elements(episodes_arr)
          WITH ORDINALITY AS episode_item(item, ordinal)
        WHERE ordinal > episode_count - p_max_session_summaries;
      END IF;

      UPDATE public.agent_long_term_memories
      SET
        episodic_session_summaries = episodes_arr,
        consolidation_watermarks = existing_watermarks,
        updated_at = now()
      WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id
        AND user_id = p_user_id
        AND bot_user_id = p_bot_user_id;

      RETURN jsonb_build_object(
        'written', false,
        'summaryCount', jsonb_array_length(episodes_arr)
      );
    END IF;
  END IF;

  episodes_arr := episodes_arr || jsonb_build_array(p_entry);
  episode_count := jsonb_array_length(episodes_arr);
  IF episode_count > p_max_session_summaries THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
    INTO episodes_arr
    FROM jsonb_array_elements(episodes_arr)
      WITH ORDINALITY AS episode_item(item, ordinal)
    WHERE ordinal > episode_count - p_max_session_summaries;
  END IF;

  IF p_last_settled_message_at IS NOT NULL THEN
    existing_watermarks := jsonb_set(
      existing_watermarks,
      '{lastSettledMessageAt}',
      to_jsonb(p_last_settled_message_at),
      true
    );
    IF p_session_id IS NOT NULL THEN
      existing_watermarks := jsonb_set(
        existing_watermarks,
        ARRAY['bySession', p_session_id],
        to_jsonb(p_last_settled_message_at),
        true
      );
    END IF;
  END IF;

  UPDATE public.agent_long_term_memories
  SET
    episodic_session_summaries = episodes_arr,
    consolidation_watermarks = existing_watermarks,
    updated_at = now()
  WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id;

  RETURN jsonb_build_object(
    'written', true,
    'summaryCount', jsonb_array_length(episodes_arr)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.tenant_append_long_term_summary_atomic(text,text,text,text,jsonb,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_append_long_term_summary_atomic(text,text,text,text,jsonb,text,integer,text) TO service_role;
CREATE OR REPLACE FUNCTION public.append_long_term_summary_atomic(p_corp_id text, p_user_id text, p_bot_user_id text, p_entry jsonb, p_last_settled_message_at text DEFAULT NULL::text, p_max_session_summaries integer DEFAULT 20, p_session_id text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT public.tenant_append_long_term_summary_atomic(NULL,p_corp_id,p_user_id,p_bot_user_id,p_entry,p_last_settled_message_at,p_max_session_summaries,p_session_id)
$$;
REVOKE ALL ON FUNCTION public.append_long_term_summary_atomic(text,text,text,jsonb,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.append_long_term_summary_atomic(text,text,text,jsonb,text,integer,text) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_mark_long_term_settled_boundary(p_tenant_id text, p_corp_id text, p_user_id text, p_bot_user_id text, p_last_settled_message_at text, p_session_id text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  existing_summary jsonb;
  existing_watermarks jsonb;
  episodes_arr jsonb := '[]'::jsonb;
  legacy_recent jsonb := '[]'::jsonb;
  legacy_archive jsonb := '[]'::jsonb;
  legacy_by_session jsonb := '{}'::jsonb;
  current_by_session jsonb := '{}'::jsonb;
  legacy_fallback text;
  current_fallback text;
  episode_count integer;
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;

  INSERT INTO public.agent_long_term_memories (
    tenant_id,corp_id,
    user_id,
    bot_user_id,
    semantic_profile,
    episodic_session_summaries,
    consolidation_watermarks
  )
  VALUES (
    p_tenant_id,p_corp_id,
    p_user_id,
    p_bot_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data(),
    default_consolidation_watermarks()
  )
  ON CONFLICT(tenant_id,corp_id,user_id,bot_user_id) DO NOTHING;

  SELECT
    COALESCE(episodic_session_summaries, default_long_term_summary_data()),
    COALESCE(consolidation_watermarks, default_consolidation_watermarks())
  INTO existing_summary, existing_watermarks
  FROM public.agent_long_term_memories
  WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
  FOR UPDATE;

  IF jsonb_typeof(existing_summary) = 'array' THEN
    episodes_arr := existing_summary;
  ELSE
    IF jsonb_typeof(existing_summary -> 'recent') = 'array' THEN
      SELECT COALESCE(jsonb_agg(item ORDER BY ordinal DESC), '[]'::jsonb)
      INTO legacy_recent
      FROM jsonb_array_elements(existing_summary -> 'recent')
        WITH ORDINALITY AS recent_item(item, ordinal)
      WHERE jsonb_typeof(item) = 'object';
    END IF;

    IF jsonb_typeof(existing_summary -> 'archive') = 'string' THEN
      IF NULLIF(BTRIM(existing_summary ->> 'archive'), '') IS NOT NULL THEN
        legacy_archive := jsonb_build_array(jsonb_build_object(
          'summary', existing_summary ->> 'archive',
          'sessionId', '',
          'startTime', '',
          'endTime', ''
        ));
      END IF;
    ELSIF jsonb_typeof(existing_summary -> 'archive') = 'array' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'summary', segment #>> '{}',
            'sessionId', '',
            'startTime', '',
            'endTime', ''
          )
          ORDER BY ordinal
        ),
        '[]'::jsonb
      )
      INTO legacy_archive
      FROM jsonb_array_elements(existing_summary -> 'archive')
        WITH ORDINALITY AS archive_item(segment, ordinal)
      WHERE jsonb_typeof(segment) = 'string'
        AND NULLIF(BTRIM(segment #>> '{}'), '') IS NOT NULL;
    END IF;
    episodes_arr := legacy_archive || legacy_recent;
  END IF;

  episode_count := jsonb_array_length(episodes_arr);
  IF episode_count > 20 THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
    INTO episodes_arr
    FROM jsonb_array_elements(episodes_arr)
      WITH ORDINALITY AS episode_item(item, ordinal)
    WHERE ordinal > episode_count - 20;
  END IF;

  IF jsonb_typeof(existing_summary -> 'lastSettledBySession') = 'object' THEN
    legacy_by_session := existing_summary -> 'lastSettledBySession';
  END IF;
  IF jsonb_typeof(existing_watermarks -> 'bySession') = 'object' THEN
    current_by_session := existing_watermarks -> 'bySession';
  END IF;
  legacy_fallback := NULLIF(existing_summary ->> 'lastSettledMessageAt', '');
  current_fallback := NULLIF(existing_watermarks ->> 'lastSettledMessageAt', '');
  existing_watermarks := jsonb_build_object(
    'bySession', legacy_by_session || current_by_session,
    'lastSettledMessageAt', COALESCE(current_fallback, legacy_fallback)
  );
  existing_watermarks := jsonb_set(
    existing_watermarks,
    '{lastSettledMessageAt}',
    to_jsonb(p_last_settled_message_at),
    true
  );
  IF p_session_id IS NOT NULL THEN
    existing_watermarks := jsonb_set(
      existing_watermarks,
      ARRAY['bySession', p_session_id],
      to_jsonb(p_last_settled_message_at),
      true
    );
  END IF;

  UPDATE public.agent_long_term_memories
  SET
    episodic_session_summaries = episodes_arr,
    consolidation_watermarks = existing_watermarks,
    updated_at = now()
  WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.tenant_mark_long_term_settled_boundary(text,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_mark_long_term_settled_boundary(text,text,text,text,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.mark_long_term_settled_boundary(p_corp_id text, p_user_id text, p_bot_user_id text, p_last_settled_message_at text, p_session_id text DEFAULT NULL::text)
 RETURNS void LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT public.tenant_mark_long_term_settled_boundary(NULL,p_corp_id,p_user_id,p_bot_user_id,p_last_settled_message_at,p_session_id)
$$;
REVOKE ALL ON FUNCTION public.mark_long_term_settled_boundary(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_long_term_settled_boundary(text,text,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_apply_active_booking_projection(p_tenant_id text, p_corp_id text, p_user_id text, p_operation text, p_work_order_id bigint, p_occurred_at timestamp with time zone, p_job_id bigint DEFAULT NULL::bigint, p_interview_time text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r public.agent_long_term_memories%ROWTYPE;
  entries jsonb;
  versions jsonb;
  entry jsonb;
  previous jsonb;
  previous_at timestamptz;
  reset_at timestamptz;
  entry_id text;
  result_entries jsonb := '[]'::jsonb;
  tombstone boolean;
BEGIN
  IF nullif(btrim(p_corp_id),'') IS NULL OR nullif(btrim(p_user_id),'') IS NULL
    OR p_occurred_at IS NULL OR p_operation NOT IN ('set','clear')
    OR (p_operation='set' AND p_work_order_id IS NULL) THEN
    RAISE EXCEPTION 'invalid booking projection input';
  END IF;
  INSERT INTO public.agent_long_term_memories(tenant_id,corp_id,user_id,bot_user_id)
    VALUES(p_tenant_id,p_corp_id,p_user_id,NULL)
    ON CONFLICT(tenant_id,corp_id,user_id,bot_user_id) DO NOTHING;
  SELECT * INTO STRICT r FROM public.agent_long_term_memories
    WHERE tenant_id IS NOT DISTINCT FROM p_tenant_id AND corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id IS NULL FOR UPDATE;
  versions := r.active_booking_versions;
  reset_at := (versions->>'reset_at')::timestamptz;
  -- Normalize the old single pointer and new list without changing the public JSON shape.
  SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO entries FROM (
    SELECT DISTINCT ON (value->>'work_order_id') value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.active_booking->'bookings')='array'
        THEN r.active_booking->'bookings' ELSE '[]'::jsonb END ||
      CASE WHEN r.active_booking ? 'work_order_id' THEN jsonb_build_array(r.active_booking-'bookings') ELSE '[]'::jsonb END
    ) WHERE value->>'work_order_id' ~ '^\d+$'
    ORDER BY value->>'work_order_id', (value->>'linked_at')::timestamptz DESC
  ) normalized;

  IF p_work_order_id IS NOT NULL THEN
    entry_id := p_work_order_id::text;
    IF EXISTS (
      SELECT 1 FROM public.agent_action_records WHERE corp_id=p_corp_id
        AND (p_tenant_id IS NULL OR public.stride_business_tenant(account_id,input_occurred_at)=p_tenant_id)
        AND mode='execute' AND status='succeeded'
        AND kind IN ('sponge.booking','sponge.cancel','sponge.modify')
        AND input_occurred_at>p_occurred_at
        AND (result->>'workOrderId'=entry_id OR intent->'recovery'->>'workOrderId'=entry_id)
    ) THEN RETURN jsonb_build_object('superseded',true); END IF;
    SELECT value INTO previous FROM jsonb_array_elements(entries) WHERE value->>'work_order_id'=entry_id;
    previous_at := greatest((versions->entry_id->>'occurred_at')::timestamptz,
      (previous->>'linked_at')::timestamptz, reset_at);
    tombstone := coalesce((versions->entry_id->>'deleted')::boolean,false);
    IF p_occurred_at < previous_at OR
      (p_occurred_at = reset_at) OR
      (p_occurred_at = previous_at AND tombstone AND p_operation='set') THEN
      RETURN jsonb_build_object('superseded',true);
    END IF;
    -- Equal-version sets are idempotent, including when a provider read changed meanwhile.
    IF p_occurred_at = previous_at AND p_operation='set' THEN
      RETURN jsonb_build_object('superseded',false);
    END IF;
    SELECT coalesce(jsonb_agg(value),'[]'::jsonb) INTO result_entries
      FROM jsonb_array_elements(entries) WHERE value->>'work_order_id'<>entry_id;
    IF p_operation='set' THEN
      entry := jsonb_build_object('work_order_id',p_work_order_id,'linked_at',p_occurred_at,'job_id',p_job_id);
      IF nullif(btrim(p_interview_time),'') IS NOT NULL THEN
        entry := entry || jsonb_build_object('interview_time',p_interview_time);
      END IF;
      result_entries := result_entries || jsonb_build_array(entry);
    END IF;
    versions := jsonb_set(versions,ARRAY[entry_id],jsonb_build_object('occurred_at',p_occurred_at,'deleted',p_operation='clear'));
  ELSE
    IF p_occurred_at <= reset_at THEN RETURN jsonb_build_object('superseded',true); END IF;
    -- Reset only versions at/before this event; concurrent newer bookings survive.
    FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
      entry_id := entry->>'work_order_id';
      previous_at := greatest((versions->entry_id->>'occurred_at')::timestamptz,(entry->>'linked_at')::timestamptz);
      IF previous_at > p_occurred_at THEN result_entries := result_entries || jsonb_build_array(entry);
      ELSE versions := jsonb_set(versions,ARRAY[entry_id],jsonb_build_object('occurred_at',p_occurred_at,'deleted',true));
      END IF;
    END LOOP;
    versions := jsonb_set(versions,'{reset_at}',to_jsonb(p_occurred_at));
  END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY (value->>'linked_at')::timestamptz DESC,value->>'work_order_id'),'[]'::jsonb)
    INTO result_entries FROM (SELECT value FROM jsonb_array_elements(result_entries)
      ORDER BY (value->>'linked_at')::timestamptz DESC,value->>'work_order_id' LIMIT 10) capped;
  UPDATE public.agent_long_term_memories SET
    active_booking=CASE WHEN jsonb_array_length(result_entries)=0 THEN NULL
      ELSE result_entries->0 || jsonb_build_object('bookings',result_entries) END,
    active_booking_versions=versions, updated_at=now() WHERE id=r.id;
  RETURN jsonb_build_object('superseded',false);
END;
$function$;
REVOKE ALL ON FUNCTION public.tenant_apply_active_booking_projection(text,text,text,text,bigint,timestamp with time zone,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_apply_active_booking_projection(text,text,text,text,bigint,timestamp with time zone,bigint,text) TO service_role;
CREATE OR REPLACE FUNCTION public.apply_active_booking_projection(p_corp_id text, p_user_id text, p_operation text, p_work_order_id bigint, p_occurred_at timestamp with time zone, p_job_id bigint DEFAULT NULL::bigint, p_interview_time text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE sql SET search_path=public,pg_temp AS $$
 SELECT public.tenant_apply_active_booking_projection(NULL,p_corp_id,p_user_id,p_operation,p_work_order_id,p_occurred_at,p_job_id,p_interview_time)
$$;
REVOKE ALL ON FUNCTION public.apply_active_booking_projection(text,text,text,bigint,timestamp with time zone,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_active_booking_projection(text,text,text,bigint,timestamp with time zone,bigint,text) TO service_role;
