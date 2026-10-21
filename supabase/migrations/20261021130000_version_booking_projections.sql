-- Current booking pointers are shared by (corp_id,user_id), including across chats/accounts.
-- Keep the existing active_booking JSON shape. Versions/tombstones are separate and must
-- not be pruned while older action records/inputs can still be recovered.
ALTER TABLE public.agent_long_term_memories
  ADD COLUMN IF NOT EXISTS active_booking_versions jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Cross-kind succeeded evidence closes the window before the newer action's projection
-- has been written (booking targets phone/job; modify/cancel target work-order ID).
CREATE INDEX IF NOT EXISTS idx_action_succeeded_result_work_order ON public.agent_action_records
  (corp_id,(result->>'workOrderId'),input_occurred_at DESC)
  WHERE mode='execute' AND status='succeeded' AND kind IN ('sponge.booking','sponge.cancel','sponge.modify');
CREATE INDEX IF NOT EXISTS idx_action_succeeded_intent_work_order ON public.agent_action_records
  (corp_id,(intent->'recovery'->>'workOrderId'),input_occurred_at DESC)
  WHERE mode='execute' AND status='succeeded' AND kind IN ('sponge.booking','sponge.cancel','sponge.modify');

CREATE OR REPLACE FUNCTION public.apply_active_booking_projection(
  p_corp_id text, p_user_id text, p_operation text, p_work_order_id bigint,
  p_occurred_at timestamptz, p_job_id bigint DEFAULT NULL, p_interview_time text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  INSERT INTO public.agent_long_term_memories(corp_id,user_id,bot_user_id)
    VALUES(p_corp_id,p_user_id,NULL)
    ON CONFLICT(corp_id,user_id) WHERE bot_user_id IS NULL DO NOTHING;
  SELECT * INTO STRICT r FROM public.agent_long_term_memories
    WHERE corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id IS NULL FOR UPDATE;
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
$$;
REVOKE ALL ON FUNCTION public.apply_active_booking_projection(text,text,text,bigint,timestamptz,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_active_booking_projection(text,text,text,bigint,timestamptz,bigint,text) TO service_role;

-- A late successful booking also carries historical identity facts. Keep the existing
-- confidence merge, but filter old fields under the same row lock used by that merge.
CREATE OR REPLACE FUNCTION public.upsert_booking_profile_facts(
  p_corp_id text, p_user_id text, p_bot_user_id text, p_profile_facts jsonb,
  p_message_metadata jsonb DEFAULT NULL, p_preference_facts jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  existing jsonb;
  filtered jsonb := coalesce(p_profile_facts,'{}'::jsonb);
  field record;
BEGIN
  IF nullif(btrim(p_bot_user_id),'') IS NULL THEN RAISE EXCEPTION 'stable account required'; END IF;
  INSERT INTO public.agent_long_term_memories(corp_id,user_id,bot_user_id)
    VALUES(p_corp_id,p_user_id,p_bot_user_id) ON CONFLICT(corp_id,user_id,bot_user_id) DO NOTHING;
  SELECT semantic_profile INTO existing FROM public.agent_long_term_memories
    WHERE corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id=p_bot_user_id FOR UPDATE;
  FOR field IN SELECT key,value FROM jsonb_each(filtered) LOOP
    IF (existing->field.key->>'updatedAt')::timestamptz >= (field.value->>'updatedAt')::timestamptz THEN
      filtered := filtered-field.key;
    END IF;
  END LOOP;
  RETURN public.upsert_long_term_profile_facts(p_corp_id,p_user_id,p_bot_user_id,filtered,p_message_metadata,p_preference_facts);
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_booking_profile_facts(text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_booking_profile_facts(text,text,text,jsonb,jsonb,jsonb) TO service_role;
