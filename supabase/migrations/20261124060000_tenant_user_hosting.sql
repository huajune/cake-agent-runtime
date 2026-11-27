-- The runtime pauses a single chat_id. Only a conversation with an unambiguous
-- owner may change that shared state from a tenant dashboard.
ALTER TABLE public.user_hosting_status ADD COLUMN tenant_id text REFERENCES public.tenants(id);

CREATE FUNCTION public.tenant_can_manage_hosting_chat(p_tenant_id text, p_chat_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT FROM public.chat_messages c WHERE c.tenant_id = p_tenant_id AND c.chat_id = p_chat_id
      AND c.role = 'user' AND c.is_self IS NOT TRUE
  ) AND NOT EXISTS (
    SELECT FROM public.chat_messages c WHERE c.chat_id = p_chat_id AND (
      c.tenant_id <> p_tenant_id OR (c.tenant_id IS NULL AND NOT EXISTS (
        SELECT FROM public.chat_messages owned WHERE owned.chat_id = c.chat_id AND owned.tenant_id = p_tenant_id
          AND owned.im_bot_id = c.im_bot_id
          AND (c.hosting_connection_id IS NULL OR c.hosting_connection_id = owned.hosting_connection_id)
      ))
    )
  ) AND NOT EXISTS (
    SELECT FROM public.user_hosting_status h WHERE h.user_id = p_chat_id AND h.is_paused
      AND (h.tenant_id <> p_tenant_id OR (h.handoff_scope->>'botImId' IS NOT NULL AND NOT EXISTS (
        SELECT FROM public.chat_messages c WHERE c.tenant_id = p_tenant_id AND c.chat_id = p_chat_id
          AND c.im_bot_id = h.handoff_scope->>'botImId'
      )))
  )
$$;

CREATE FUNCTION public.set_tenant_user_hosting(
  p_tenant_id text, p_chat_id text, p_enabled boolean, p_pause_expires_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET statement_timeout = '4s' AS $$
BEGIN
  IF p_enabled IS NULL OR nullif(btrim(p_chat_id), '') IS NULL OR length(p_chat_id) > 100
     OR (NOT p_enabled AND (p_pause_expires_at IS NULL OR p_pause_expires_at <= now())) THEN
    RAISE EXCEPTION 'invalid hosting switch' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.user-hosting.' || p_chat_id, 0));
  PERFORM FROM public.user_hosting_status WHERE user_id = p_chat_id FOR UPDATE;
  IF NOT public.tenant_can_manage_hosting_chat(p_tenant_id, p_chat_id) THEN
    RAISE EXCEPTION 'chat outside tenant scope' USING ERRCODE = '42501';
  END IF;
  IF p_enabled THEN
    -- Keep the original handoff scope so the existing resume listener can resolve it.
    UPDATE public.user_hosting_status SET is_paused = false, resumed_at = now(), pause_expires_at = NULL,
      is_permanent = false, pause_reason = NULL, pause_operator = NULL, pause_source = NULL
      WHERE user_id = p_chat_id AND is_paused;
  ELSE
    INSERT INTO public.user_hosting_status AS h
      (user_id, tenant_id, is_paused, paused_at, pause_expires_at, is_permanent, pause_source, pause_count)
      VALUES (p_chat_id, p_tenant_id, true, now(), p_pause_expires_at, false, 'manual', 1)
    ON CONFLICT (user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, is_paused = true,
      paused_at = EXCLUDED.paused_at, pause_expires_at = EXCLUDED.pause_expires_at,
      is_permanent = false, pause_source = 'manual', pause_reason = NULL, pause_operator = NULL, handoff_scope = NULL
      WHERE NOT coalesce(h.is_paused AND (h.is_permanent OR h.pause_expires_at > now()), false);
  END IF;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.tenant_can_manage_hosting_chat(text,text),
  public.set_tenant_user_hosting(text,text,boolean,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_can_manage_hosting_chat(text,text),
  public.set_tenant_user_hosting(text,text,boolean,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_dashboard_activity_read(p_kind text, p_tenant_id text, p_start date, p_end date, p_params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '4s'
AS $function$
DECLARE v_result jsonb;
  v_start timestamptz := p_start::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_limit int := least(greatest(coalesce((p_params->>'limit')::int,600),1),600);
BEGIN
  IF p_kind = 'users' THEN
    WITH usage AS MATERIALIZED (
      SELECT chat_id,bot_im_id,sum(token_usage) AS tokens FROM public.tenant_visible_message_processing_records
      WHERE tenant_id=p_tenant_id AND received_at>=v_start AND received_at<v_end GROUP BY chat_id,bot_im_id
    ), users AS (
      SELECT c.chat_id AS "chatId",max(c.candidate_name) AS "odName",c.im_bot_id AS "imBotId",
        count(*) AS "messageCount",coalesce(max(usage.tokens),0) AS "tokenUsage",extract(epoch FROM min(c.timestamp))*1000 AS "firstActiveAt",
        extract(epoch FROM max(c.timestamp))*1000 AS "lastActiveAt"
      FROM public.tenant_visible_chat_messages c
      LEFT JOIN usage ON usage.chat_id=c.chat_id AND usage.bot_im_id=c.im_bot_id
      WHERE c.tenant_id=p_tenant_id AND c.timestamp>=v_start AND c.timestamp<v_end
        AND c.role='user' AND c.is_self IS DISTINCT FROM true
        AND (p_params->>'afterChatId' IS NULL OR
          (c.chat_id,c.im_bot_id)>(p_params->>'afterChatId',p_params->>'afterBotId'))
      GROUP BY c.chat_id,c.im_bot_id
      ORDER BY c.chat_id,c.im_bot_id LIMIT v_limit+1
    ), page AS MATERIALIZED (SELECT * FROM users ORDER BY "chatId","imBotId" LIMIT v_limit),
    permissions AS MATERIALIZED (
      SELECT page.*, public.tenant_can_manage_hosting_chat(p_tenant_id,"chatId") AS "canToggleHosting" FROM page
    ), visible AS (
      SELECT p.*, coalesce(h.is_paused AND (h.is_permanent OR h.pause_expires_at>now()),false) AS "isPaused"
      FROM permissions p LEFT JOIN public.user_hosting_status h ON h.user_id=p."chatId"
        AND (h.tenant_id=p_tenant_id OR (h.tenant_id IS NULL AND (p."canToggleHosting" OR
          (h.handoff_scope->>'botImId'=p."imBotId" AND public.stride_business_tenant(p."imBotId",h.paused_at)=p_tenant_id))))
    )
    SELECT jsonb_build_object('users',(SELECT coalesce(jsonb_agg(to_jsonb(visible) ORDER BY "chatId","imBotId"),'[]') FROM visible),
      'nextCursor',CASE WHEN (SELECT count(*) FROM users)>v_limit THEN
        (SELECT jsonb_build_object('chatId',"chatId",'botId',"imBotId") FROM page ORDER BY "chatId" DESC,"imBotId" DESC LIMIT 1)
        ELSE NULL END) INTO v_result;
  ELSIF p_kind IN ('business-trend','user-trend') THEN
    WITH days AS (SELECT generate_series(p_start,p_end,interval '1 day')::date AS d),
    msgs AS (SELECT report_date AS d,count(*) AS cnt FROM public.tenant_visible_ops_events
      WHERE tenant_id=p_tenant_id AND report_date BETWEEN p_start AND p_end
        AND (event_name='candidate.message_received' OR (p_kind='business-trend' AND event_name='agent.replied'))
      GROUP BY report_date),
    sessions AS (SELECT report_date AS d,count(DISTINCT chat_id) AS cnt
      FROM public.tenant_visible_ops_events WHERE tenant_id=p_tenant_id AND report_date BETWEEN p_start AND p_end AND chat_id IS NOT NULL
        AND (p_kind='business-trend' OR event_name='candidate.message_received') GROUP BY report_date)
    SELECT coalesce(jsonb_agg(jsonb_build_object('date',days.d,'messageCount',coalesce(msgs.cnt,0),
      CASE WHEN p_kind='user-trend' THEN 'userCount' ELSE 'sessionCount' END,coalesce(sessions.cnt,0)) ORDER BY days.d),'[]') INTO v_result
      FROM days LEFT JOIN msgs USING(d) LEFT JOIN sessions USING(d);
    IF p_kind='business-trend' THEN
      v_result:=jsonb_build_object('trend',v_result,'caliber','business','floor',jsonb_build_object(
        'opsEventsFrom',(SELECT min(report_date) FROM public.tenant_visible_ops_events WHERE tenant_id=p_tenant_id AND report_date BETWEEN p_start AND p_end),
        'dailyOpsReportFrom',(SELECT min(report_date) FROM public.tenant_visible_ops_events WHERE tenant_id=p_tenant_id AND report_date BETWEEN p_start AND p_end),
        'userActivityFrom',NULL));
    END IF;
  ELSE RAISE EXCEPTION 'unsupported center chat read'; END IF;
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.tenant_dashboard_activity_read(text,text,date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_dashboard_activity_read(text,text,date,date,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
