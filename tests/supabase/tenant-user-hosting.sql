-- Synthetic sessions, including colliding chat IDs. All changes roll back.
BEGIN;
DO $$
DECLARE
  prefix text := 'qa-hosting-' || gen_random_uuid()::text;
  own_chat text := prefix || '-henan';
  other_chat text := prefix || '-shanghai';
  mixed_chat text := prefix || '-mixed';
  bot text := prefix || '-bot';
  other_bot text := prefix || '-other-bot';
  at_time timestamptz := now();
  day date := (at_time AT TIME ZONE 'Asia/Shanghai')::date;
  expiry timestamptz := (day + 1)::timestamp AT TIME ZONE 'Asia/Shanghai';
  users jsonb;
  item text;
  enabled boolean;
BEGIN
  IF has_function_privilege('authenticated','public.set_tenant_user_hosting(text,text,boolean,timestamptz)','EXECUTE')
    OR has_function_privilege('anon','public.tenant_can_manage_hosting_chat(text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.set_tenant_user_hosting(text,text,boolean,timestamptz)','EXECUTE')
    THEN RAISE EXCEPTION 'invalid hosting RPC grants'; END IF;
  INSERT INTO public.hosting_group_ownership VALUES
    (prefix,'qa-a',at_time - interval '1 day','henan'),(prefix,'qa-b',at_time - interval '1 day','shanghai_recruitment');
  INSERT INTO public.hosting_bot_memberships VALUES
    (prefix,bot,at_time - interval '1 day','qa-a'),(prefix,other_bot,at_time - interval '1 day','qa-b');
  INSERT INTO public.chat_messages(chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id) VALUES
    (own_chat,own_chat,'user','QA',at_time,bot,prefix),
    (other_chat,other_chat,'user','QA',at_time,other_bot,prefix),
    (mixed_chat,mixed_chat || 'a','user','QA',at_time,bot,prefix),
    (mixed_chat,mixed_chat || 'b','user','QA',at_time,other_bot,prefix),
    (prefix,prefix,'user','QA',at_time,bot,NULL);

  IF NOT public.set_tenant_user_hosting('henan',own_chat,false,expiry)
    THEN RAISE EXCEPTION 'own pause did not change the state'; END IF;
  IF NOT EXISTS (SELECT FROM public.user_hosting_status WHERE user_id=own_chat AND tenant_id='henan'
      AND is_paused AND NOT is_permanent AND pause_expires_at=expiry)
    THEN RAISE EXCEPTION 'own pause was not persisted'; END IF;
  IF public.set_tenant_user_hosting('henan',own_chat,false,expiry)
    THEN RAISE EXCEPTION 'duplicate pause changed the state'; END IF;
  users := public.tenant_dashboard_activity_read('users','henan',day,day,jsonb_build_object('afterChatId',prefix,'afterBotId','')) -> 'users';
  IF NOT users @> jsonb_build_array(jsonb_build_object('chatId',own_chat,'isPaused',true,'canToggleHosting',true))
    OR users @> jsonb_build_array(jsonb_build_object('chatId',other_chat))
    OR NOT users @> jsonb_build_array(jsonb_build_object('chatId',mixed_chat,'canToggleHosting',false))
    THEN RAISE EXCEPTION 'tenant list did not reflect the effective switch'; END IF;
  FOREACH item IN ARRAY ARRAY[other_chat,mixed_chat,prefix,prefix || '-missing'] LOOP
    FOREACH enabled IN ARRAY ARRAY[true,false] LOOP
      BEGIN
        PERFORM public.set_tenant_user_hosting('henan',item,enabled,expiry);
        RAISE EXCEPTION 'accepted a foreign, ambiguous or unassigned session';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END LOOP;
  END LOOP;
  BEGIN
    PERFORM public.set_tenant_user_hosting('shanghai_recruitment',own_chat,true,expiry);
    RAISE EXCEPTION 'foreign tenant resumed a Henan session';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF NOT public.set_tenant_user_hosting('henan',own_chat,true,expiry)
    THEN RAISE EXCEPTION 'own resume was not persisted'; END IF;
  IF public.set_tenant_user_hosting('henan',own_chat,true,expiry)
    THEN RAISE EXCEPTION 'duplicate resume repeated its side effects'; END IF;
  users := public.tenant_dashboard_activity_read('users','henan',day,day,jsonb_build_object('afterChatId',prefix,'afterBotId','')) -> 'users';
  IF NOT users @> jsonb_build_array(jsonb_build_object('chatId',own_chat,'isPaused',false)) OR
    EXISTS (SELECT FROM public.user_hosting_status WHERE user_id IN (other_chat,mixed_chat,prefix))
    THEN RAISE EXCEPTION 'readback or rejected write failed'; END IF;
  UPDATE public.user_hosting_status SET tenant_id=NULL,is_paused=true,is_permanent=true,pause_expires_at=NULL WHERE user_id=own_chat;
  users := public.tenant_dashboard_activity_read('users','henan',day,day,jsonb_build_object('afterChatId',prefix,'afterBotId','')) -> 'users';
  IF NOT users @> jsonb_build_array(jsonb_build_object('chatId',own_chat,'isPaused',true)) OR
    public.set_tenant_user_hosting('henan',own_chat,false,expiry)
    THEN RAISE EXCEPTION 'legacy permanent pause lost'; END IF;
  UPDATE public.user_hosting_status SET handoff_scope=jsonb_build_object('botImId',other_bot) WHERE user_id=own_chat;
  IF public.tenant_can_manage_hosting_chat('henan',own_chat)
    THEN RAISE EXCEPTION 'foreign pause evidence ignored'; END IF;
END $$;
ROLLBACK;
