-- A confirmed booking is recorded before its independent group invitation.
-- Only this metadata may arrive later. Never rewrite occurrence time or count.
CREATE OR REPLACE FUNCTION public.enrich_booking_invite_event(
  p_corp_id text,
  p_idempotency_key text,
  p_group_invite jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.ops_events%ROWTYPE;
  v_allowed jsonb;
  v_previous text;
BEGIN
  IF jsonb_typeof(p_group_invite) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_group_invite->'outcome') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'group_invite requires an outcome object';
  END IF;
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_allowed
  FROM jsonb_each(p_group_invite)
  WHERE key IN ('outcome','attempted','success','city','group_name','delivery','simulated');

  SELECT * INTO v_event FROM public.ops_events
  WHERE corp_id = p_corp_id AND event_name = 'booking.succeeded'
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  v_previous := v_event.payload #>> '{group_invite,outcome}';
  -- Terminal historical outcomes are immutable; late unknown/error replays
  -- cannot downgrade a confirmed invitation. Unknown may be reconciled later.
  IF v_previous IS NULL OR v_previous = 'unknown' THEN
    UPDATE public.ops_events SET payload = jsonb_set(
      CASE WHEN jsonb_typeof(v_event.payload) = 'object' THEN v_event.payload ELSE '{}'::jsonb END,
      '{group_invite}', v_allowed, true
    ) WHERE id = v_event.id;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.enrich_booking_invite_event(text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enrich_booking_invite_event(text,text,jsonb) TO service_role;
