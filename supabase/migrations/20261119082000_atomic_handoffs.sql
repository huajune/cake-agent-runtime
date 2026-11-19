ALTER TABLE public.user_hosting_status ADD COLUMN IF NOT EXISTS handoff_scope jsonb;
ALTER TABLE public.handoff_events ADD COLUMN IF NOT EXISTS recorded_at timestamptz;
CREATE INDEX IF NOT EXISTS handoff_chat_scope_sequence ON public.handoff_events
  (chat_id,corp_id,bot_im_id,sequence_no DESC);
-- The immutable fact key (corp_id, event_name, idempotency_key) is already unique in ops_events.
CREATE OR REPLACE FUNCTION public.record_handoff(p_ticket jsonb,p_origin text,p_manager text,p_group text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE ticket public.handoff_events; old_ticket public.handoff_events; fact public.ops_events;
  payload jsonb; first_write boolean; seq integer; event_result jsonb;
BEGIN
  ticket := jsonb_populate_record(NULL::public.handoff_events,p_ticket);
  IF nullif(ticket.corp_id,'') IS NULL OR nullif(ticket.chat_id,'') IS NULL OR
     nullif(ticket.idempotency_key,'') IS NULL OR ticket.created_at IS NULL THEN RAISE EXCEPTION 'missing handoff identity'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('handoff:'||ticket.chat_id,0));
  SELECT * INTO old_ticket FROM public.handoff_events WHERE corp_id=ticket.corp_id AND idempotency_key=ticket.idempotency_key;
  SELECT * INTO fact FROM public.ops_events WHERE corp_id=ticket.corp_id AND event_name='handoff.triggered'
    AND idempotency_key=ticket.idempotency_key;
  first_write := old_ticket.id IS NULL AND fact.id IS NULL;
  IF (old_ticket.id IS NOT NULL AND (old_ticket.chat_id IS DISTINCT FROM ticket.chat_id OR
       old_ticket.bot_im_id IS DISTINCT FROM ticket.bot_im_id)) OR (fact.id IS NOT NULL AND
       (fact.chat_id IS DISTINCT FROM ticket.chat_id OR fact.bot_im_id IS DISTINCT FROM ticket.bot_im_id)) THEN
    RETURN 'scope_conflict';
  END IF;
  IF old_ticket.id IS NOT NULL AND fact.id IS NOT NULL THEN RETURN 'duplicate'; END IF;
  IF old_ticket.id IS NOT NULL THEN ticket := old_ticket; END IF;
  payload := jsonb_build_object('reason_code',ticket.reason_code,'reason',ticket.reason,'stage',ticket.stage,
    'work_order_id',ticket.work_order_id,'job_id',ticket.job_id,'missing_job_info',ticket.missing_job_info,
    'origin',coalesce(p_origin,'agent_tool'));
  IF fact.id IS NULL THEN
    event_result := public.upsert_ops_event(ticket.corp_id,'handoff.triggered',ticket.idempotency_key,
      ticket.created_at,ticket.bot_im_id,p_manager,p_group,NULL,ticket.user_id,ticket.chat_id,payload);
    IF event_result->>'inserted' IS DISTINCT FROM 'true' THEN
      -- A rolling legacy writer won. Retry against its frozen fact in a fresh transaction.
      RAISE EXCEPTION 'handoff concurrent fact' USING ERRCODE='40001';
    END IF;
  ELSE
    -- Never resurrect an expired ticket, or report an existing external intervention as new.
    IF fact.occurred_at < now()-interval '90 days' THEN RETURN 'duplicate'; END IF;
    ticket := jsonb_populate_record(ticket,fact.payload - 'origin');
    ticket.created_at := fact.occurred_at;
    ticket.user_id := fact.user_id;
  END IF;
  IF old_ticket.id IS NULL THEN
    SELECT coalesce(max(sequence_no),0)+1 INTO seq FROM public.handoff_events
      WHERE chat_id=ticket.chat_id AND corp_id=ticket.corp_id AND bot_im_id IS NOT DISTINCT FROM ticket.bot_im_id;
    INSERT INTO public.handoff_events(chat_id,corp_id,user_id,reason_code,reason,action_advice,stage,bot_im_id,
      work_order_id,job_id,missing_job_info,idempotency_key,created_at,sequence_no,recorded_at)
      VALUES(ticket.chat_id,ticket.corp_id,ticket.user_id,ticket.reason_code,ticket.reason,ticket.action_advice,ticket.stage,
        ticket.bot_im_id,ticket.work_order_id,ticket.job_id,ticket.missing_job_info,ticket.idempotency_key,ticket.created_at,seq,clock_timestamp())
      ON CONFLICT(corp_id,idempotency_key) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'handoff concurrent ticket' USING ERRCODE='40001'; END IF;
  END IF;
  RETURN CASE WHEN first_write THEN 'inserted' ELSE 'duplicate' END;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_hosting_handoffs(p_user text,p_outcome text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE state public.user_hosting_status; chat text; corp text; bot text; count_scopes int; n int;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('expired','resumed') THEN RAISE EXCEPTION 'invalid handoff outcome'; END IF;
  SELECT * INTO state FROM public.user_hosting_status WHERE user_id=p_user FOR SHARE;
  IF NOT FOUND OR state.is_paused OR state.resumed_at IS NULL THEN RETURN 0; END IF;
  IF (state.handoff_scope->>'pausedAt')::timestamptz IS DISTINCT FROM state.paused_at THEN
    state.handoff_scope := NULL;
  END IF;
  chat := coalesce(state.handoff_scope->>'chatId',p_user);
  PERFORM pg_advisory_xact_lock(hashtextextended('handoff:'||chat,0));
  IF state.handoff_scope IS NOT NULL THEN
    corp := state.handoff_scope->>'corpId'; bot := state.handoff_scope->>'botImId';
  ELSE
    -- Older pauses have no tenant or account. Only a unique historical scope is usable.
    SELECT count(*),min(corp_id),min(bot_im_id) INTO count_scopes,corp,bot FROM
      (SELECT DISTINCT corp_id,bot_im_id FROM public.handoff_events WHERE chat_id=chat LIMIT 2) scopes;
    IF count_scopes <> 1 THEN RETURN 0; END IF;
  END IF;
  IF nullif(corp,'') IS NULL OR nullif(bot,'') IS NULL THEN RETURN 0; END IF;
  UPDATE public.handoff_events SET outcome=p_outcome,resolved_at=state.resumed_at WHERE
    chat_id=chat AND corp_id=corp AND bot_im_id=bot AND outcome IS NULL AND created_at<=state.resumed_at
    AND coalesce(recorded_at,created_at)<=state.resumed_at;
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.record_handoff(jsonb,text,text,text),public.resolve_hosting_handoffs(text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_handoff(jsonb,text,text,text),public.resolve_hosting_handoffs(text,text) TO service_role;
NOTIFY pgrst,'reload schema';
