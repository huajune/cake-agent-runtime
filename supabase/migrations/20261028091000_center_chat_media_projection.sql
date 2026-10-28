-- 聊天详情只暴露现有消息气泡需要的媒体字段，保留图片/语音/文件查看能力。
-- 不返回原始回调中的请求头、凭据、内部上下文或嵌套任意对象。
CREATE OR REPLACE FUNCTION public.center_chat_media_payload(p_payload jsonb,p_type text)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER
SET search_path=public,pg_temp
AS $$
  SELECT coalesce(jsonb_object_agg(k,p_payload->k),'{}'::jsonb)
  FROM unnest(CASE
    WHEN p_type IN ('IMAGE','EMOTION') THEN ARRAY[
      'artworkUrl','originalImageUrl','originalUrl','originImageUrl','originUrl','fullImageUrl','fullUrl',
      'hdImageUrl','hdUrl','cdnOriginalImageUrl','cdnOriginalUrl','cdnorigimgurl','downloadUrl','mediaUrl',
      'imageUrl','url','thumbnailUrl','thumbUrl','thumbImageUrl','thumb','cdnThumbUrl','cdnthumburl','previewImageUrl','previewUrl']
    WHEN p_type='VOICE' THEN ARRAY['voiceUrl','url','wxVoiceUrl','text','duration']
    WHEN p_type='VIDEO' THEN ARRAY['videoUrl','url','thumbnailUrl','thumbUrl','duration']
    WHEN p_type='FILE' THEN ARRAY['fileUrl','url','name','fileName','size']
    WHEN p_type='LINK' THEN ARRAY['url','title','description','desc','thumbnailUrl','thumbUrl']
    WHEN p_type='LOCATION' THEN ARRAY['name','address','latitude','longitude']
    WHEN p_type='MINI_PROGRAM' THEN ARRAY['title','description','thumbUrl','thumbnailUrl','iconUrl']
    WHEN p_type='CONTACT_CARD' THEN ARRAY['name','nickname','alias','avatar']
    WHEN p_type='ROOM_INVITE' THEN ARRAY['roomName','groupName','title','name']
    ELSE ARRAY[]::text[] END) AS k
  WHERE jsonb_typeof(p_payload->k) IN ('string','number');
$$;
REVOKE ALL ON FUNCTION public.center_chat_media_payload(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.center_chat_media_payload(jsonb,text) TO service_role;

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
        message_type AS "messageType",source,is_self AS "isSelf",avatar,contact_type AS "contactType",
        public.center_chat_media_payload(payload,message_type) AS payload
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
    ), users AS (
      SELECT c.chat_id AS "chatId",max(c.candidate_name) AS "odName",c.im_bot_id AS "imBotId",
        count(*) AS "messageCount",coalesce(max(usage.tokens),0) AS "tokenUsage",extract(epoch FROM min(c.timestamp))*1000 AS "firstActiveAt",
        extract(epoch FROM max(c.timestamp))*1000 AS "lastActiveAt",
        coalesce(h.is_paused AND (h.is_permanent OR h.pause_expires_at>now()),false) AS "isPaused"
      FROM chat_messages c LEFT JOIN user_hosting_status h ON h.user_id=c.chat_id
      LEFT JOIN usage ON usage.chat_id=c.chat_id AND usage.bot_im_id=c.im_bot_id
      WHERE c.im_bot_id=ANY(p_bot_ids) AND c.timestamp>=v_start AND c.timestamp<v_end
        AND (p_params->>'afterChatId' IS NULL OR
          (c.chat_id,c.im_bot_id)>(p_params->>'afterChatId',p_params->>'afterBotId'))
      GROUP BY c.chat_id,c.im_bot_id,h.is_paused,h.is_permanent,h.pause_expires_at
      ORDER BY c.chat_id,c.im_bot_id LIMIT v_limit+1
    ), page AS (SELECT * FROM users ORDER BY "chatId","imBotId" LIMIT v_limit)
    SELECT jsonb_build_object('users',(SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY "chatId","imBotId"),'[]') FROM page),
      'nextCursor',CASE WHEN (SELECT count(*) FROM users)>v_limit THEN
        (SELECT jsonb_build_object('chatId',"chatId",'botId',"imBotId") FROM page ORDER BY "chatId" DESC,"imBotId" DESC LIMIT 1)
        ELSE NULL END) INTO v_result;
  ELSIF p_kind IN ('business-trend','user-trend') THEN
    WITH days AS (SELECT generate_series(p_start,p_end,interval '1 day')::date AS d),
    msgs AS (SELECT report_date AS d,sum(candidate_message_count + CASE WHEN p_kind='business-trend' THEN agent_reply_count ELSE 0 END) AS cnt
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

REVOKE ALL ON FUNCTION public.center_dashboard_chat_read(text,text[],date,date,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.center_dashboard_chat_read(text,text[],date,date,jsonb) TO service_role;
