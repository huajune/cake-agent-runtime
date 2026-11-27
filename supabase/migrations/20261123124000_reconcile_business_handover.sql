-- A directory change can be detected after traffic already arrived. Recheck the
-- bounded review interval using the effective time approved by the administrator.
ALTER TABLE public.hosting_bot_handovers ADD COLUMN business_reconciled boolean NOT NULL DEFAULT false;
CREATE INDEX processing_source_bot_time_idx ON public.message_processing_records(bot_im_id,source_occurred_at);
CREATE INDEX touch_source_bot_time_idx ON public.reengagement_touch_records(bot_im_id,anchor_at);
CREATE INDEX handoff_source_bot_time_idx ON public.handoff_events(bot_im_id,created_at);
CREATE INDEX ops_source_bot_time_idx ON public.ops_events(bot_im_id,occurred_at);

-- The immutable ops ledger is also the source for the per-tenant daily projection.
-- Recompute only the Bot/day touched by a repair, including booking details.
CREATE FUNCTION public.rebuild_tenant_ops_day(p_corp text,p_day date,p_bot text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM daily_ops_report WHERE corp_id=p_corp AND report_date=p_day AND bot_im_id=p_bot;
  INSERT INTO daily_ops_report(tenant_id,corp_id,report_date,bot_im_id,manager_name,group_name,
    friends_added_count,agent_opening_sent_count,break_ice_count,candidate_message_count,agent_reply_count,
    job_recommend_count,precheck_pass_count,booking_success_count,booking_fail_count,group_invite_count,
    handoff_count,interview_pass_count,booking_cancel_count,interview_modified_count,candidate_summary,booking_brands)
  SELECT tenant_id,p_corp,p_day,p_bot,max(manager_name),max(group_name),
    count(*) FILTER(WHERE col='friends_added_count'),count(*) FILTER(WHERE col='agent_opening_sent_count'),
    count(*) FILTER(WHERE col='break_ice_count'),count(*) FILTER(WHERE col='candidate_message_count'),
    count(*) FILTER(WHERE col='agent_reply_count'),count(*) FILTER(WHERE col='job_recommend_count'),
    count(*) FILTER(WHERE col='precheck_pass_count'),count(*) FILTER(WHERE col='booking_success_count'),
    count(*) FILTER(WHERE col='booking_fail_count'),count(*) FILTER(WHERE col='group_invite_count'),
    count(*) FILTER(WHERE col='handoff_count'),count(*) FILTER(WHERE col='interview_pass_count'),
    count(*) FILTER(WHERE col='booking_cancel_count'),count(*) FILTER(WHERE col='interview_modified_count'),
    string_agg(nullif(trim(concat_ws(' ',payload->>'candidate_name',payload->>'phone')),''),chr(10) ORDER BY occurred_at,id)
      FILTER(WHERE event_name='booking.succeeded'),
    array_agg(DISTINCT payload->>'brand_name') FILTER(WHERE event_name='booking.succeeded' AND coalesce(payload->>'brand_name','')<>'')
  FROM (SELECT e.*,ops_event_projection_column(e.event_name) col FROM ops_events e
    WHERE corp_id=p_corp AND report_date=p_day AND bot_im_id=p_bot) events
  WHERE col IS NOT NULL GROUP BY tenant_id;
END $$;

CREATE FUNCTION public.lock_business_event_write() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('cake.hosting.stride-primary',0));
  RETURN NEW;
END $$;
CREATE TRIGGER aa_lock_ops_tenant BEFORE INSERT ON public.ops_events FOR EACH ROW EXECUTE FUNCTION public.lock_business_event_write();
CREATE TRIGGER aa_lock_processing_tenant BEFORE INSERT ON public.message_processing_records FOR EACH ROW EXECUTE FUNCTION public.lock_business_event_write();
CREATE TRIGGER aa_lock_touch_tenant BEFORE INSERT ON public.reengagement_touch_records FOR EACH ROW EXECUTE FUNCTION public.lock_business_event_write();
CREATE TRIGGER aa_lock_handoff_tenant BEFORE INSERT ON public.handoff_events FOR EACH ROW EXECUTE FUNCTION public.lock_business_event_write();

CREATE FUNCTION public.reconcile_business_handover(p_connection_id text) RETURNS integer
LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='5s' AS $$
DECLARE h hosting_bot_handovers%ROWTYPE; field record; item record; n int; changed int:=0; new_tenant text;
  prior user_activity%ROWTYPE; activity_day date;
BEGIN
  IF p_connection_id IS DISTINCT FROM 'stride-primary' THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.'||p_connection_id,0));
  SELECT * INTO h FROM hosting_bot_handovers WHERE connection_id=p_connection_id AND confirmed_at IS NOT NULL
    AND NOT business_reconciled ORDER BY confirmed_at,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR field IN SELECT * FROM (VALUES ('message_processing_records','source_occurred_at'),
      ('reengagement_touch_records','anchor_at'),('handoff_events','created_at')) AS fields(tbl,at_col) LOOP
    EXECUTE format('WITH batch AS (SELECT id FROM public.%1$I WHERE bot_im_id=$1 AND %2$I BETWEEN $2 AND $3
      AND tenant_id IS DISTINCT FROM public.stride_business_tenant(bot_im_id,%2$I) ORDER BY %2$I,id LIMIT 100)
      UPDATE public.%1$I SET tenant_id=NULL FROM batch WHERE %1$I.id=batch.id',field.tbl,field.at_col)
      USING h.bot_im_id,h.review_from,h.confirmed_at;
    GET DIAGNOSTICS n=ROW_COUNT; changed:=changed+n;
  END LOOP;
  FOR item IN WITH batch AS (SELECT id FROM ops_events WHERE bot_im_id=h.bot_im_id AND occurred_at BETWEEN h.review_from AND h.confirmed_at
      AND tenant_id IS DISTINCT FROM stride_business_tenant(bot_im_id,occurred_at) ORDER BY occurred_at,id LIMIT 100),
    corrected AS (UPDATE ops_events e SET tenant_id=NULL FROM batch b WHERE e.id=b.id RETURNING corp_id,report_date)
    SELECT corp_id,report_date,count(*) AS cnt FROM corrected GROUP BY corp_id,report_date LOOP
    PERFORM rebuild_tenant_ops_day(item.corp_id,item.report_date,h.bot_im_id);
    changed:=changed+item.cnt;
  END LOOP;
  FOR item IN SELECT * FROM user_activity_events WHERE bot_im_id=h.bot_im_id AND occurred_at BETWEEN h.review_from AND h.confirmed_at
    AND tenant_id IS DISTINCT FROM stride_business_tenant(bot_im_id,occurred_at) ORDER BY occurred_at,event_key LIMIT 100 FOR UPDATE LOOP
    activity_day:=(item.occurred_at AT TIME ZONE 'Asia/Shanghai')::date;
    UPDATE user_activity SET message_count=message_count-item.message_count,token_usage=token_usage-item.token_usage
      WHERE chat_id=item.chat_id AND activity_date=activity_day AND tenant_id IS NOT DISTINCT FROM item.tenant_id
      RETURNING * INTO STRICT prior;
    IF prior.message_count=0 AND prior.token_usage=0 THEN DELETE FROM user_activity WHERE id=prior.id; END IF;
    new_tenant:=stride_business_tenant(item.bot_im_id,item.occurred_at);
    PERFORM upsert_user_activity(item.chat_id,prior.od_id,prior.od_name,item.message_count,item.token_usage,
      item.occurred_at,prior.bot_user_id,item.bot_im_id);
    UPDATE user_activity_events SET tenant_id=new_tenant WHERE event_key=item.event_key;
    changed:=changed+1;
  END LOOP;
  IF changed=0 THEN UPDATE hosting_bot_handovers SET business_reconciled=true WHERE id=h.id; END IF;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION public.rebuild_tenant_ops_day(text,date,text), public.reconcile_business_handover(text),public.lock_business_event_write() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_tenant_ops_day(text,date,text), public.reconcile_business_handover(text),public.lock_business_event_write() TO service_role;
