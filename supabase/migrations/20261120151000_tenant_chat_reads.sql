-- Chat detail, session lists and counts share the owner recorded on the event.
-- Partial indexes omit pending history until its source and ownership are verified.
CREATE INDEX IF NOT EXISTS idx_chat_tenant_time ON public.chat_messages (tenant_id, timestamp DESC, chat_id)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_tenant_session ON public.chat_messages (tenant_id, chat_id, timestamp DESC)
  WHERE tenant_id IS NOT NULL;

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
      FROM chat_messages WHERE tenant_id=p_tenant_id AND chat_id=p_params->>'chatId'
      ORDER BY timestamp DESC LIMIT 2000
    ) m;
  ELSIF p_kind = 'chat-stats' THEN
    SELECT jsonb_build_object('totalSessions',count(DISTINCT chat_id),'totalMessages',count(*),
      'activeSessions',count(DISTINCT chat_id) FILTER(WHERE timestamp>now()-interval '1 hour')) INTO v_result
      FROM chat_messages WHERE tenant_id=p_tenant_id AND timestamp>=v_start AND timestamp<v_end;
  ELSIF p_kind = 'sessions' THEN
    WITH sessions AS MATERIALIZED (
      SELECT chat_id,max(candidate_name) AS candidate_name,max(manager_name) AS manager_name,count(*) AS cnt,max(timestamp) AS last_at
      FROM chat_messages WHERE tenant_id=p_tenant_id AND timestamp>=v_start AND timestamp<v_end
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
        SELECT content,avatar,contact_type FROM chat_messages
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
      FROM chat_messages WHERE tenant_id=p_tenant_id AND timestamp>=v_start AND timestamp<v_end GROUP BY 1
    ) t;
  ELSE RAISE EXCEPTION 'unsupported center chat read'; END IF;
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.tenant_dashboard_chat_read(text,text,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_dashboard_chat_read(text,text,date,date,jsonb) TO service_role;
