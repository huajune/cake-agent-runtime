-- An original event group or a dated membership can prove ownership. A detected but
-- unconfirmed move suspends both paths in the interval since the previous verified scan.
CREATE OR REPLACE FUNCTION public.hosting_tenant_at(
  p_connection_id text,p_bot_im_id text,p_group_id text,p_occurred_at timestamptz
) RETURNS text LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE assigned text;
BEGIN
  IF p_connection_id IS NULL OR p_occurred_at IS NULL OR EXISTS (
    SELECT FROM hosting_bot_handovers WHERE connection_id=p_connection_id AND bot_im_id=p_bot_im_id
      AND confirmed_at IS NULL AND review_from<=p_occurred_at
  ) THEN RETURN NULL; END IF;
  SELECT group_id INTO assigned FROM hosting_bot_memberships WHERE connection_id=p_connection_id
    AND bot_im_id=p_bot_im_id AND effective_from<=p_occurred_at ORDER BY effective_from DESC LIMIT 1;
  IF FOUND AND (assigned IS NULL OR (p_group_id IS NOT NULL AND p_group_id<>assigned)) THEN RETURN NULL; END IF;
  RETURN (SELECT tenant_id FROM hosting_group_ownership WHERE connection_id=p_connection_id
    AND group_id=coalesce(p_group_id,assigned) AND effective_from<=p_occurred_at ORDER BY effective_from DESC LIMIT 1);
END $$;

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS hosting_observed_group_id text;
CREATE OR REPLACE FUNCTION public.assign_chat_tenant() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE resolved text;
BEGIN
  IF NEW.hosting_connection_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('cake.hosting.'||NEW.hosting_connection_id,0));
    resolved := hosting_tenant_at(NEW.hosting_connection_id,NEW.im_bot_id,NEW.hosting_group_id,NEW.timestamp);
    IF NEW.hosting_observed_group_id IS NOT NULL AND resolved IS NOT NULL
      AND NOT EXISTS(SELECT FROM hosting_current_bots m WHERE m.connection_id=NEW.hosting_connection_id
        AND m.bot_im_id=NEW.im_bot_id AND m.group_id=NEW.hosting_observed_group_id)
      AND NOT EXISTS(SELECT FROM hosting_bot_handovers h WHERE h.connection_id=NEW.hosting_connection_id AND
        h.bot_im_id=NEW.im_bot_id AND NEW.timestamp BETWEEN h.review_from AND h.confirmed_at)
      THEN resolved := NULL; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.tenant_id IS NOT NULL THEN
    IF ROW(NEW.hosting_connection_id,NEW.hosting_group_id,NEW.hosting_observed_group_id,NEW.im_bot_id,NEW.timestamp)
        IS DISTINCT FROM ROW(OLD.hosting_connection_id,OLD.hosting_group_id,OLD.hosting_observed_group_id,OLD.im_bot_id,OLD.timestamp)
      OR (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id AND NOT EXISTS(
        SELECT FROM hosting_bot_handovers WHERE connection_id=OLD.hosting_connection_id AND bot_im_id=OLD.im_bot_id
          AND NOT reconciled AND confirmed_at IS NOT NULL AND OLD.timestamp BETWEEN review_from AND confirmed_at))
      THEN RAISE EXCEPTION '已归属聊天的来源和组织不可更改' USING ERRCODE='23514'; END IF;
    IF NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN RETURN NEW; END IF;
  END IF;
  IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM resolved THEN
    RAISE EXCEPTION '聊天组织与已核实的绑定不一致' USING ERRCODE='23514'; END IF;
  NEW.tenant_id := resolved;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS assign_chat_tenant ON public.chat_messages;
CREATE TRIGGER assign_chat_tenant BEFORE INSERT OR UPDATE OF tenant_id,hosting_connection_id,hosting_group_id,hosting_observed_group_id,im_bot_id,timestamp
  ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION public.assign_chat_tenant();

-- Suppress uncertain rows immediately, including old-stamped rows between two directory scans.
CREATE OR REPLACE VIEW public.tenant_visible_chat_messages WITH (security_invoker=true) AS
  SELECT c.* FROM public.chat_messages c WHERE c.tenant_id IS NOT NULL AND NOT EXISTS(
    SELECT FROM public.hosting_bot_handovers h WHERE h.connection_id=c.hosting_connection_id
      AND h.bot_im_id=c.im_bot_id AND NOT h.reconciled AND c.timestamp>=h.review_from
      AND (h.confirmed_at IS NULL OR (c.timestamp<=h.confirmed_at AND c.tenant_id IS DISTINCT FROM
        public.hosting_tenant_at(c.hosting_connection_id,c.im_bot_id,c.hosting_group_id,c.timestamp))));
REVOKE ALL ON public.tenant_visible_chat_messages FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.tenant_visible_chat_messages TO service_role;

-- Resume by (event time, message ID). Both the cursor and the ownership corrections commit together.
CREATE OR REPLACE FUNCTION public.reconcile_hosting_handover(p_connection_id text)
RETURNS integer LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='5s' AS $$
DECLARE h hosting_bot_handovers%ROWTYPE; ids text[]; last_time timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.'||p_connection_id,0));
  SELECT * INTO h FROM hosting_bot_handovers WHERE connection_id=p_connection_id
    AND confirmed_at IS NOT NULL AND NOT reconciled ORDER BY confirmed_at,id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT array_agg(message_id ORDER BY timestamp,message_id),max(timestamp) INTO ids,last_time FROM (
    SELECT timestamp,message_id FROM chat_messages WHERE hosting_connection_id=p_connection_id AND im_bot_id=h.bot_im_id
      AND timestamp BETWEEN h.review_from AND h.confirmed_at
      AND (timestamp,message_id)>(coalesce(h.cursor_time,'-infinity'::timestamptz),coalesce(h.cursor_message,''))
      ORDER BY timestamp,message_id LIMIT 300
  ) batch;
  UPDATE chat_messages c SET tenant_id=NULL WHERE c.message_id=ANY(ids) AND c.tenant_id IS DISTINCT FROM
    hosting_tenant_at(c.hosting_connection_id,c.im_bot_id,c.hosting_group_id,c.timestamp);
  UPDATE hosting_bot_handovers SET cursor_time=last_time,cursor_message=ids[cardinality(ids)],
    reconciled=coalesce(cardinality(ids),0)<300 WHERE id=h.id;
  RETURN coalesce(cardinality(ids),0);
END $$;
REVOKE ALL ON FUNCTION public.reconcile_hosting_handover(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_hosting_handover(text) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_dashboard_chat_read(
  p_kind text, p_tenant_id text, p_start date, p_end date, p_params jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp SET statement_timeout = '4s'
AS $$
DECLARE v_result jsonb;
  v_start timestamptz := p_start::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_limit int := least(greatest(coalesce((p_params->>'limit')::int,600),1),600);
BEGIN
  IF p_tenant_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_start>p_end OR p_end-p_start>365 THEN
    RAISE EXCEPTION 'invalid tenant or bounded range';
  END IF;
  IF p_kind = 'messages' THEN
    SELECT jsonb_build_object('chatId',p_params->>'chatId','messages',coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.timestamp),'[]')) INTO v_result FROM (
      SELECT message_id AS id,message_id AS "messageId",chat_id AS "chatId",role,content,
        extract(epoch FROM timestamp)*1000 AS timestamp,candidate_name AS "candidateName",manager_name AS "managerName",
        message_type AS "messageType",source,is_self AS "isSelf",avatar,contact_type AS "contactType",
        public.center_chat_media_payload(payload,message_type) AS payload
      FROM public.tenant_visible_chat_messages WHERE tenant_id=p_tenant_id AND chat_id=p_params->>'chatId'
      ORDER BY timestamp DESC LIMIT 2000
    ) m;
  ELSIF p_kind = 'chat-stats' THEN
    SELECT jsonb_build_object('totalSessions',count(DISTINCT chat_id),'totalMessages',count(*),
      'activeSessions',count(DISTINCT chat_id) FILTER(WHERE timestamp>now()-interval '1 hour')) INTO v_result
      FROM public.tenant_visible_chat_messages WHERE tenant_id=p_tenant_id AND timestamp>=v_start AND timestamp<v_end;
  ELSIF p_kind = 'sessions' THEN
    WITH sessions AS MATERIALIZED (
      SELECT chat_id,max(candidate_name) AS candidate_name,max(manager_name) AS manager_name,count(*) AS cnt,max(timestamp) AS last_at
      FROM public.tenant_visible_chat_messages WHERE tenant_id=p_tenant_id AND timestamp>=v_start AND timestamp<v_end
      GROUP BY chat_id
    ), filtered AS MATERIALIZED (
      SELECT * FROM sessions WHERE coalesce(p_params->>'search','')='' OR
        strpos(lower(coalesce(candidate_name,'')||' '||coalesce(manager_name,'')||' '||chat_id),lower(p_params->>'search'))>0
    ), page AS (
      SELECT * FROM filtered WHERE p_params->>'cursorTimestamp' IS NULL OR
        (last_at,chat_id)<((p_params->>'cursorTimestamp')::timestamptz,p_params->>'cursorChatId')
      ORDER BY last_at DESC,chat_id DESC LIMIT v_limit
    ), rows AS (
      SELECT p.chat_id AS "chatId",p.candidate_name AS "candidateName",p.manager_name AS "managerName",p.cnt AS "messageCount",
        extract(epoch FROM p.last_at)*1000 AS "lastTimestamp",m.content AS "lastMessage",m.avatar,m.contact_type AS "contactType"
      FROM page p LEFT JOIN LATERAL (
        SELECT content,avatar,contact_type FROM public.tenant_visible_chat_messages
        WHERE tenant_id=p_tenant_id AND chat_id=p.chat_id AND timestamp>=v_start AND timestamp<v_end
        ORDER BY timestamp DESC LIMIT 1
      ) m ON true ORDER BY p.last_at DESC,p.chat_id DESC
    ), tail AS (SELECT * FROM page ORDER BY last_at,chat_id LIMIT 1)
    SELECT jsonb_build_object('sessions',(SELECT coalesce(jsonb_agg(to_jsonb(rows)),'[]') FROM rows),
      'total',(SELECT count(*) FROM filtered),'nextCursor',
      CASE WHEN EXISTS(SELECT 1 FROM filtered f,tail t WHERE (f.last_at,f.chat_id)<(t.last_at,t.chat_id))
      THEN (SELECT jsonb_build_object('timestamp',last_at,'chatId',chat_id) FROM tail) ELSE NULL END) INTO v_result;
  ELSIF p_kind='chat-trend' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.date),'[]') INTO v_result FROM (
      SELECT (timestamp AT TIME ZONE 'Asia/Shanghai')::date AS date,count(*) AS "messageCount",count(DISTINCT chat_id) AS "sessionCount"
      FROM public.tenant_visible_chat_messages WHERE tenant_id=p_tenant_id AND timestamp>=v_start AND timestamp<v_end GROUP BY 1
    ) t;
  ELSE RAISE EXCEPTION 'unsupported center chat read'; END IF;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.tenant_dashboard_chat_read(text,text,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_dashboard_chat_read(text,text,date,date,jsonb) TO service_role;
