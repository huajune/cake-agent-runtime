-- Run after the tenant migrations on a disposable database. All fixtures roll back.
BEGIN;
DO $$
DECLARE result record; response jsonb; observed timestamptz;
  sample jsonb := '[{"group_id":"qa-new-group","tenant_id":"henan","bot_im_ids":["qa-new-bot"]},{"group_id":"qa-empty","tenant_id":"headquarters","bot_im_ids":[]}]';
BEGIN
  IF (SELECT count(*) FROM public.tenants WHERE id IN ('henan','headquarters','shanghai_recruitment'))<>3
    OR has_table_privilege('authenticated','public.tenants','INSERT')
    OR has_function_privilege('anon','public.backfill_chat_tenants(text,text[],boolean)','EXECUTE')
    THEN RAISE EXCEPTION 'tenant registry or access is incorrect'; END IF;
  INSERT INTO public.tenants (id,name) VALUES ('qa-supplier','供应商示例');
  INSERT INTO public.dashboard_accounts (phone,name,organization) VALUES ('+12025550198','测试供应商成员','qa-supplier');
  BEGIN
    INSERT INTO public.dashboard_accounts (phone,name,organization) VALUES ('+12025550199','测试成员','qa-absent');
    RAISE EXCEPTION 'account accepted an unknown tenant';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  PERFORM public.register_hosting_directory('qa-new',sample,true);
  IF EXISTS(SELECT FROM public.hosting_group_ownership WHERE connection_id='qa-new')
    THEN RAISE EXCEPTION 'directory check wrote a row'; END IF;
  PERFORM public.register_hosting_directory('qa-new',sample,false);
  PERFORM public.register_hosting_directory('qa-new',sample,false);
  SELECT effective_from INTO STRICT observed FROM public.hosting_bot_memberships WHERE connection_id='qa-new';
  IF public.hosting_tenant_at('qa-new','qa-new-bot',NULL,observed) IS DISTINCT FROM 'henan'
    OR public.hosting_tenant_at('qa-new','qa-new-bot',NULL,observed-interval '1 millisecond') IS NOT NULL
    OR (SELECT count(*) FROM public.hosting_group_ownership WHERE connection_id='qa-new')<>2
    THEN RAISE EXCEPTION 'current observation was lost or backdated'; END IF;
  INSERT INTO public.hosting_group_ownership VALUES
    ('qa-channel','qa-a','2026-01-01Z','henan'),('qa-channel','qa-b','2026-01-01Z','shanghai_recruitment'),
    ('qa-other','qa-a','2026-01-01Z','qa-supplier');
  INSERT INTO public.hosting_bot_memberships VALUES
    ('qa-channel','qa-bot','2026-01-01Z','qa-a'),('qa-channel','qa-shanghai-bot','2026-01-01Z','qa-b'),
    ('qa-other','qa-bot','2026-01-01Z','qa-a');
  IF public.hosting_tenant_at('qa-channel','qa-newly-scanned','qa-a','2026-01-31Z') IS DISTINCT FROM 'henan'
    OR public.hosting_tenant_at('qa-channel','qa-newly-scanned',NULL,'2026-01-31Z') IS NOT NULL
    THEN RAISE EXCEPTION 'new bot must have an original event group or a dated binding'; END IF;
  INSERT INTO public.chat_messages (chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id,hosting_group_id)
    VALUES ('qa-chat','qa-after','user','after','2026-02-01Z','qa-shanghai-bot','qa-channel','qa-b'),
           ('qa-chat','qa-before','user','before','2026-01-31Z','qa-bot','qa-channel',NULL),
           ('qa-chat','qa-conflict','user','conflict','2026-01-31Z','qa-bot','qa-channel','qa-b'),
           ('qa-chat','qa-unregistered','user','unknown Bot','2026-03-01Z','qa-unknown','qa-channel',NULL),
           ('qa-chat','qa-other','user','other','2026-01-31Z','qa-bot','qa-other','qa-a'),
           ('qa-chat','qa-legacy','user','legacy','2026-01-30Z','qa-bot',NULL,NULL),
           ('qa-chat','qa-missing','user','missing','2026-01-30Z',NULL,NULL,NULL);
  IF (SELECT tenant_id FROM public.chat_messages WHERE message_id='qa-before') IS DISTINCT FROM 'henan'
    OR (SELECT tenant_id FROM public.chat_messages WHERE message_id='qa-after') IS DISTINCT FROM 'shanghai_recruitment'
    OR (SELECT tenant_id FROM public.chat_messages WHERE message_id='qa-other') IS DISTINCT FROM 'qa-supplier'
    OR EXISTS (SELECT FROM public.chat_messages WHERE message_id IN ('qa-unregistered','qa-conflict','qa-legacy','qa-missing') AND tenant_id IS NOT NULL)
    THEN RAISE EXCEPTION 'event-time ownership failed'; END IF;
  SELECT * INTO result FROM public.backfill_chat_tenants('qa-channel',ARRAY['qa-legacy','qa-missing','qa-legacy','qa-absent']);
  IF (result.requested,result.matched,result.assignable,result.applied) IS DISTINCT FROM (3,2,1,0)
    THEN RAISE EXCEPTION 'invalid dry run'; END IF;
  SELECT * INTO result FROM public.backfill_chat_tenants('qa-channel',ARRAY['qa-legacy','qa-missing'],true);
  IF result.applied<>1 THEN RAISE EXCEPTION 'backfill did not assign existing evidence'; END IF;
  SELECT * INTO result FROM public.backfill_chat_tenants('qa-channel',ARRAY['qa-legacy','qa-missing'],true);
  IF result.applied<>0 THEN RAISE EXCEPTION 'backfill was not idempotent'; END IF;
  response := public.tenant_dashboard_chat_read('messages','henan','2026-01-01','2026-03-01','{"chatId":"qa-chat"}');
  IF jsonb_array_length(response->'messages')<>2 OR response->'messages'->0->>'id'<>'qa-legacy'
    OR response->'messages'->1->>'id'<>'qa-before' THEN RAISE EXCEPTION 'chat detail mixed tenants'; END IF;
  response := public.tenant_dashboard_chat_read('sessions','shanghai_recruitment','2026-01-01','2026-03-01','{}');
  IF (response->>'total')::integer<>1 OR response->'sessions'->0->>'lastMessage'<>'after'
    THEN RAISE EXCEPTION 'session list mixed tenants'; END IF;
  response := public.tenant_dashboard_chat_read('chat-stats','qa-supplier','2026-01-01','2026-03-01','{}');
  IF (response->>'totalMessages')::integer<>1 THEN RAISE EXCEPTION 'supplier stats mixed tenants'; END IF;
  BEGIN
    UPDATE public.chat_messages SET tenant_id='headquarters' WHERE message_id='qa-before';
    RAISE EXCEPTION 'a recorded tenant could be reassigned';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
