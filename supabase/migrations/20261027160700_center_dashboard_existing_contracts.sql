-- 中心读取保持现有 Dashboard 响应结构。每条明细、聚合、详情均在数据库内限制 bot。
-- 明确字段投影，禁止返回请求头、调用凭据、原始 payload 或内部上下文。
CREATE INDEX IF NOT EXISTS idx_reengagement_center_updated ON public.reengagement_touch_records(bot_im_id, updated_at DESC);

CREATE OR REPLACE FUNCTION public.center_dashboard_chat_read(
  p_kind text, p_bot_ids text[], p_start date, p_end date, p_params jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp SET statement_timeout = '4s'
AS $$
DECLARE v_result jsonb;
  v_start timestamptz := p_start::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_limit int := least(greatest(coalesce((p_params->>'limit')::int,600),1),600);
BEGIN
  IF p_kind = 'messages' THEN
    SELECT jsonb_build_object('chatId',p_params->>'chatId','messages',coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.timestamp),'[]')) INTO v_result FROM (
      SELECT message_id AS id,message_id AS "messageId",chat_id AS "chatId",role,content,
        extract(epoch FROM timestamp)*1000 AS timestamp,candidate_name AS "candidateName",manager_name AS "managerName",
        message_type AS "messageType",source,is_self AS "isSelf",avatar,contact_type AS "contactType"
      FROM chat_messages WHERE im_bot_id=ANY(p_bot_ids) AND chat_id=p_params->>'chatId'
      ORDER BY timestamp DESC LIMIT 2000
    ) m;
  ELSIF p_kind = 'chat-stats' THEN
    SELECT jsonb_build_object('totalSessions',count(DISTINCT chat_id),'totalMessages',count(*),
      'activeSessions',count(DISTINCT chat_id) FILTER(WHERE timestamp>now()-interval '1 hour')) INTO v_result
      FROM chat_messages WHERE im_bot_id=ANY(p_bot_ids) AND timestamp>=v_start AND timestamp<v_end;
  ELSIF p_kind = 'sessions' THEN
    WITH sessions AS MATERIALIZED (
      SELECT chat_id,max(candidate_name) AS candidate_name,max(manager_name) AS manager_name,count(*) AS cnt,max(timestamp) AS last_at
      FROM chat_messages WHERE im_bot_id=ANY(p_bot_ids) AND timestamp>=v_start AND timestamp<v_end
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
        WHERE im_bot_id=ANY(p_bot_ids) AND chat_id=p.chat_id AND timestamp>=v_start AND timestamp<v_end
        ORDER BY timestamp DESC LIMIT 1
      ) m ON true ORDER BY p.last_at DESC,p.chat_id DESC
    ), tail AS (SELECT * FROM page ORDER BY last_at,chat_id LIMIT 1)
    SELECT jsonb_build_object('sessions',(SELECT coalesce(jsonb_agg(to_jsonb(rows)),'[]') FROM rows),
      'total',(SELECT count(*) FROM filtered),'nextCursor',
      CASE WHEN EXISTS(SELECT 1 FROM filtered f,tail t WHERE (f.last_at,f.chat_id)<(t.last_at,t.chat_id))
      THEN (SELECT jsonb_build_object('timestamp',last_at,'chatId',chat_id) FROM tail) ELSE NULL END) INTO v_result;
  ELSIF p_kind = 'users' THEN
    WITH usage AS MATERIALIZED (
      SELECT chat_id,bot_im_id,sum(token_usage) AS tokens FROM message_processing_records
      WHERE bot_im_id=ANY(p_bot_ids) AND received_at>=v_start AND received_at<v_end GROUP BY chat_id,bot_im_id
    ) SELECT coalesce(jsonb_agg(to_jsonb(u)),'[]') INTO v_result FROM (
      SELECT c.chat_id AS "chatId",max(c.candidate_name) AS "odName",c.im_bot_id AS "imBotId",
        count(*) AS "messageCount",coalesce(max(usage.tokens),0) AS "tokenUsage",extract(epoch FROM min(c.timestamp))*1000 AS "firstActiveAt",
        extract(epoch FROM max(c.timestamp))*1000 AS "lastActiveAt",
        coalesce(h.is_paused AND (h.is_permanent OR h.pause_expires_at>now()),false) AS "isPaused"
      FROM chat_messages c LEFT JOIN user_hosting_status h ON h.user_id=c.chat_id
      LEFT JOIN usage ON usage.chat_id=c.chat_id AND usage.bot_im_id=c.im_bot_id
      WHERE c.im_bot_id=ANY(p_bot_ids) AND c.timestamp>=v_start AND c.timestamp<v_end
      GROUP BY c.chat_id,c.im_bot_id,h.is_paused,h.is_permanent,h.pause_expires_at
      ORDER BY max(c.timestamp) DESC LIMIT 1000
    ) u;
  ELSIF p_kind IN ('business-trend','user-trend') THEN
    WITH days AS (SELECT generate_series(p_start,p_end,interval '1 day')::date AS d),
    msgs AS (SELECT report_date AS d,sum(candidate_message_count+agent_reply_count) AS cnt
      FROM daily_ops_report WHERE bot_im_id=ANY(p_bot_ids) AND report_date BETWEEN p_start AND p_end GROUP BY report_date),
    sessions AS (SELECT report_date AS d,count(DISTINCT chat_id) AS cnt
      FROM ops_events WHERE bot_im_id=ANY(p_bot_ids) AND report_date BETWEEN p_start AND p_end AND chat_id IS NOT NULL GROUP BY report_date)
    SELECT coalesce(jsonb_agg(jsonb_build_object('date',days.d,'messageCount',coalesce(msgs.cnt,0),
      CASE WHEN p_kind='user-trend' THEN 'userCount' ELSE 'sessionCount' END,coalesce(sessions.cnt,0)) ORDER BY days.d),'[]') INTO v_result
      FROM days LEFT JOIN msgs USING(d) LEFT JOIN sessions USING(d);
    IF p_kind='business-trend' THEN
      v_result:=jsonb_build_object('trend',v_result,'caliber','business','floor',jsonb_build_object(
        'opsEventsFrom',(SELECT min(report_date) FROM ops_events WHERE bot_im_id=ANY(p_bot_ids) AND report_date BETWEEN p_start AND p_end),
        'dailyOpsReportFrom',(SELECT min(report_date) FROM daily_ops_report WHERE bot_im_id=ANY(p_bot_ids) AND report_date BETWEEN p_start AND p_end),
        'userActivityFrom',NULL));
    END IF;
  ELSIF p_kind='chat-trend' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.date),'[]') INTO v_result FROM (
      SELECT (timestamp AT TIME ZONE 'Asia/Shanghai')::date AS date,count(*) AS "messageCount",count(DISTINCT chat_id) AS "sessionCount"
      FROM chat_messages WHERE im_bot_id=ANY(p_bot_ids) AND timestamp>=v_start AND timestamp<v_end GROUP BY 1
    ) t;
  ELSE RAISE EXCEPTION 'unsupported center chat read'; END IF;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.center_dashboard_processing_read(
  p_kind text, p_bot_ids text[], p_start date, p_end date, p_params jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp SET statement_timeout = '4s'
AS $$
DECLARE v_result jsonb;
  v_start timestamptz := p_start::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';
BEGIN
  IF p_kind='processing-stats' THEN
    SELECT jsonb_build_object('total',count(*),'success',count(*) FILTER(WHERE status='success'),
      'failed',count(*) FILTER(WHERE status IN ('failure','timeout')),'avgDuration',coalesce(avg(total_duration),0),'avgTtft',coalesce(avg(ttft_ms),0)) INTO v_result
    FROM message_processing_records WHERE bot_im_id=ANY(p_bot_ids) AND received_at>=v_start AND received_at<v_end
      AND (p_params->>'userName' IS NULL OR strpos(lower(coalesce(user_name,'')),lower(p_params->>'userName'))>0)
      AND (NOT p_params ? 'managerNames' OR manager_name IN (SELECT jsonb_array_elements_text(p_params->'managerNames')));
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO v_result FROM (
      SELECT message_id AS "messageId",chat_id AS "chatId",user_id AS "userId",user_name AS "userName",manager_name AS "managerName",bot_im_id AS "botImId",
        extract(epoch FROM received_at)*1000 AS "receivedAt",message_preview AS "messagePreview",reply_preview AS "replyPreview",reply_segments AS "replySegments",
        status,scenario,total_duration AS "totalDuration",queue_duration AS "queueDuration",prep_duration AS "prepDuration",ai_duration AS "aiDuration",
        ttft_ms AS "ttftMs",send_duration AS "sendDuration",token_usage AS "tokenUsage",is_fallback AS "isFallback",fallback_success AS "fallbackSuccess",batch_id AS "batchId"
      FROM message_processing_records WHERE bot_im_id=ANY(p_bot_ids)
        AND ((p_kind='processing-detail' AND message_id=p_params->>'id') OR
          (p_kind<>'processing-detail' AND received_at>=v_start AND received_at<v_end))
        AND (p_params->>'status' IS NULL OR status=p_params->>'status')
        AND (p_params->>'chatId' IS NULL OR chat_id=p_params->>'chatId')
        AND (p_params->>'userName' IS NULL OR strpos(lower(coalesce(user_name,'')),lower(p_params->>'userName'))>0)
        AND (NOT p_params ? 'managerNames' OR manager_name IN (SELECT jsonb_array_elements_text(p_params->'managerNames')))
      ORDER BY CASE WHEN p_kind='slowest' THEN ai_duration END DESC NULLS LAST,received_at DESC,message_id DESC
      LIMIT CASE WHEN p_kind='processing-detail' THEN 1 ELSE least(greatest(coalesce((p_params->>'limit')::int,50),1),200) END
      OFFSET least(greatest(coalesce((p_params->>'offset')::int,0),0),10000)
    ) r;
    IF p_kind='processing-detail' THEN RETURN v_result->0; END IF;
  END IF;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.center_dashboard_touch_read(
  p_kind text, p_bot_ids text[], p_start date, p_end date, p_params jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp SET statement_timeout = '4s'
AS $$
DECLARE v_result jsonb;
  v_start timestamptz := p_start::timestamp AT TIME ZONE 'Asia/Shanghai';
  v_end timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';
BEGIN
  IF p_kind='touch-stats' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO v_result FROM (
      SELECT status,scenario_code,count(*) AS cnt FROM reengagement_touch_records
      WHERE bot_im_id=ANY(p_bot_ids) AND created_at>=v_start AND created_at<v_end
        AND coalesce(decision_reason,'')<>'signup_interview_gap_lt_3d' GROUP BY status,scenario_code
    ) s;
  ELSIF p_kind='weekly' THEN
    WITH w AS (
      SELECT date_trunc('week',r.created_at AT TIME ZONE 'Asia/Shanghai')::date AS week,count(*) AS registered,
        count(*) FILTER(WHERE r.status='sent') AS sent,
        count(*) FILTER(WHERE r.status='sent' AND EXISTS(SELECT 1 FROM chat_messages c
          WHERE c.im_bot_id=r.bot_im_id AND c.chat_id=r.session_id AND c.role='user'
          AND c.timestamp>r.sent_at AND c.timestamp<=r.sent_at+interval '6 hours')) AS replied
      FROM reengagement_touch_records r WHERE r.bot_im_id=ANY(p_bot_ids) AND r.created_at>=v_start AND r.created_at<v_end
        AND coalesce(r.decision_reason,'')<>'signup_interview_gap_lt_3d' GROUP BY 1
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('weekStart',week,'registered',registered,'sent',sent,'replied6h',replied,
      'replyRate',CASE WHEN sent>0 THEN replied::numeric/sent ELSE NULL END) ORDER BY week),'[]') INTO v_result FROM w;
  ELSIF p_kind='candidates' THEN
    WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON(session_id,scenario_code) session_id,user_id,corp_id,scenario_code,touch_key,status,decision_reason,shadow,fire_at,sent_at,
        outcome_kind,updated_at,candidate_name,manager_name,bot_im_id
      FROM reengagement_touch_records WHERE bot_im_id=ANY(p_bot_ids) AND updated_at>=v_start AND updated_at<v_end
      ORDER BY session_id,scenario_code,updated_at DESC,touch_key DESC
    ), visible AS MATERIALIZED (SELECT * FROM latest WHERE status<>'superseded'),
    sessions AS MATERIALIZED (
      SELECT session_id,max(updated_at) AS latest_at FROM visible v
      WHERE (p_params->>'status' IS NULL OR EXISTS(SELECT 1 FROM visible x WHERE x.session_id=v.session_id AND x.status=p_params->>'status'))
        AND (p_params->>'scenarioCode' IS NULL OR EXISTS(SELECT 1 FROM visible x WHERE x.session_id=v.session_id AND x.scenario_code=p_params->>'scenarioCode'))
        AND (coalesce(p_params->>'pendingOnly','false')<>'true' OR EXISTS(SELECT 1 FROM visible x WHERE x.session_id=v.session_id AND x.status IN ('scheduled','rescheduled') AND x.fire_at>now()))
        AND (p_params->>'keyword' IS NULL OR strpos(lower(coalesce(v.candidate_name,'')||' '||coalesce(v.manager_name,'')||' '||v.session_id),lower(p_params->>'keyword'))>0)
      GROUP BY session_id
    ), page AS (
      SELECT * FROM sessions ORDER BY latest_at DESC,session_id DESC
      LIMIT least(greatest(coalesce((p_params->>'limit')::int,50),1),200) OFFSET least(greatest(coalesce((p_params->>'offset')::int,0),0),10000)
    ), rows AS (
      SELECT jsonb_build_object('sessionId',p.session_id,'userId',i.user_id,'corpId',i.corp_id,'candidateName',i.candidate_name,
        'managerName',i.manager_name,'botImId',i.bot_im_id,'latestAt',p.latest_at,
        'nextTouch',(SELECT jsonb_build_object('scenarioCode',n.scenario_code,'touchKey',n.touch_key,'fireAt',n.fire_at) FROM visible n
          WHERE n.session_id=p.session_id AND n.status IN ('scheduled','rescheduled') AND n.fire_at>now() ORDER BY n.fire_at LIMIT 1),
        'scenarios',(SELECT jsonb_agg(jsonb_build_object('scenarioCode',x.scenario_code,'touchKey',x.touch_key,'status',x.status,
          'decisionReason',x.decision_reason,'shadow',x.shadow,'fireAt',x.fire_at,'sentAt',x.sent_at,'outcomeKind',x.outcome_kind,'updatedAt',x.updated_at) ORDER BY x.scenario_code)
          FROM visible x WHERE x.session_id=p.session_id)) AS value
      FROM page p LEFT JOIN LATERAL (SELECT * FROM latest WHERE session_id=p.session_id ORDER BY updated_at DESC LIMIT 1) i ON true
      ORDER BY p.latest_at DESC,p.session_id DESC
    ) SELECT jsonb_build_object('total',(SELECT count(*) FROM sessions),'candidates',(SELECT coalesce(jsonb_agg(value),'[]') FROM rows)) INTO v_result;
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') INTO v_result FROM (
      SELECT touch_key,session_id,user_id,corp_id,candidate_name,manager_name,bot_im_id,scenario_code,anchor_at,status,decision_reason,shadow,
        fire_at,scheduled_at,fired_at,sent_at,outcome_kind,reserve_result,created_at,updated_at,batch_id,
        CASE WHEN p_kind='touch-detail' THEN generated_text END AS generated_text,
        CASE WHEN p_kind='touch-detail' THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('at',e->>'at','event',e->>'event')),'[]')
          FROM jsonb_array_elements(events) e) END AS events
      FROM reengagement_touch_records WHERE bot_im_id=ANY(p_bot_ids)
        AND ((p_kind='touch-detail' AND touch_key=p_params->>'touchKey') OR (p_kind<>'touch-detail' AND created_at>=v_start AND created_at<v_end))
        AND (p_params->>'status' IS NULL OR status=p_params->>'status')
        AND (p_params->>'scenarioCode' IS NULL OR scenario_code=p_params->>'scenarioCode')
        AND (p_params->>'sessionId' IS NULL OR session_id=p_params->>'sessionId')
      ORDER BY created_at DESC,touch_key DESC
      LIMIT CASE WHEN p_kind='touch-detail' THEN 1 ELSE least(greatest(coalesce((p_params->>'limit')::int,50),1),200) END
      OFFSET least(greatest(coalesce((p_params->>'offset')::int,0),0),10000)
    ) r;
    IF p_kind='touch-detail' THEN RETURN v_result->0; END IF;
  END IF;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.center_dashboard_read(
  p_kind text, p_bot_ids text[], p_start date, p_end date, p_params jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp SET statement_timeout = '4s'
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start>p_end OR p_end-p_start>365 THEN RAISE EXCEPTION 'invalid bounded range'; END IF;
  IF p_kind IN ('messages','chat-stats','sessions','users','business-trend','user-trend','chat-trend') THEN
    RETURN center_dashboard_chat_read(p_kind,p_bot_ids,p_start,p_end,p_params);
  ELSIF p_kind IN ('processing-stats','processing','processing-detail','slowest') THEN
    RETURN center_dashboard_processing_read(p_kind,p_bot_ids,p_start,p_end,p_params);
  ELSIF p_kind IN ('touch-stats','touches','touch-detail','weekly','candidates') THEN
    RETURN center_dashboard_touch_read(p_kind,p_bot_ids,p_start,p_end,p_params);
  END IF;
  RAISE EXCEPTION 'unsupported center read';
END $$;

REVOKE ALL ON FUNCTION public.center_dashboard_chat_read(text,text[],date,date,jsonb),
  public.center_dashboard_processing_read(text,text[],date,date,jsonb),public.center_dashboard_touch_read(text,text[],date,date,jsonb),
  public.center_dashboard_read(text,text[],date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.center_dashboard_chat_read(text,text[],date,date,jsonb),
  public.center_dashboard_processing_read(text,text[],date,date,jsonb),public.center_dashboard_touch_read(text,text[],date,date,jsonb),
  public.center_dashboard_read(text,text[],date,date,jsonb) TO service_role;
