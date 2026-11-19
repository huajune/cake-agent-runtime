-- A new writer supplies -1 with a full document. Legacy writes and imports use
-- the full format. Positive markers are produced by these triggers only.
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS payload_text_v1 smallint;
ALTER TABLE public.test_executions ADD COLUMN IF NOT EXISTS response_text_v1 smallint;

CREATE OR REPLACE FUNCTION public.chat_read_payload(m public.chat_messages)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
  SELECT CASE WHEN m.payload_text_v1 IS NULL THEN m.payload ELSE
    (CASE WHEN (m.payload_text_v1 & 1)=1 THEN jsonb_build_object('text',m.content) ELSE '{}' END) ||
    (CASE WHEN (m.payload_text_v1 & 2)=2 THEN jsonb_build_object('pureText',m.content) ELSE '{}' END)
  END;
$$;
CREATE OR REPLACE FUNCTION public.chat_store_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE requested boolean := NEW.payload_text_v1 = -1; mask smallint;
BEGIN
  NEW.payload_text_v1 := NULL;
  IF requested IS NOT TRUE OR NEW.message_type IS DISTINCT FROM 'TEXT' OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
     OR (NEW.payload - ARRAY['text','pureText']) <> '{}' OR NEW.payload = '{}'
     OR ((NEW.payload ? 'text') AND NEW.payload->'text' IS DISTINCT FROM to_jsonb(NEW.content))
     OR ((NEW.payload ? 'pureText') AND NEW.payload->'pureText' IS DISTINCT FROM to_jsonb(NEW.content))
     OR (TG_OP='UPDATE' AND NEW.content IS DISTINCT FROM OLD.content)
     OR NOT public.runtime_storage_enabled('chat_text') THEN RETURN NEW; END IF;
  mask := (NEW.payload ? 'text')::integer + 2*(NEW.payload ? 'pureText')::integer;
  NEW.payload_text_v1 := mask;
  NEW.payload := NULL;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.chat_preserve_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content AND NEW.payload_text_v1 IS NOT NULL THEN
    NEW.payload := public.chat_read_payload(OLD);
    NEW.payload_text_v1 := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS a_chat_store_payload ON public.chat_messages;
CREATE TRIGGER a_chat_store_payload BEFORE INSERT OR UPDATE OF payload ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_store_payload();
DROP TRIGGER IF EXISTS z_chat_preserve_payload ON public.chat_messages;
CREATE TRIGGER z_chat_preserve_payload BEFORE UPDATE OF content ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_preserve_payload();

CREATE OR REPLACE FUNCTION public.test_read_response(t public.test_executions)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
  SELECT CASE WHEN t.response_text_v1=1 THEN t.agent_response || jsonb_build_object('text',t.actual_output)
    ELSE t.agent_response END;
$$;
CREATE OR REPLACE FUNCTION public.test_store_response() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE requested boolean := NEW.response_text_v1 = -1;
BEGIN
  NEW.response_text_v1 := NULL;
  IF requested IS TRUE AND NEW.actual_output IS NOT NULL AND jsonb_typeof(NEW.agent_response)='object'
     AND NEW.agent_response->'text' = to_jsonb(NEW.actual_output)
     AND (TG_OP='INSERT' OR NEW.actual_output IS NOT DISTINCT FROM OLD.actual_output OR OLD.response_text_v1 IS NULL)
     AND public.runtime_storage_enabled('test_text') THEN
    NEW.response_text_v1 := 1;
    NEW.agent_response := NEW.agent_response - 'text';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.test_preserve_response() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF OLD.response_text_v1=1 AND NEW.actual_output IS DISTINCT FROM OLD.actual_output AND NEW.response_text_v1=1 THEN
    NEW.agent_response := public.test_read_response(OLD);
    NEW.response_text_v1 := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS a_test_store_response ON public.test_executions;
CREATE TRIGGER a_test_store_response BEFORE INSERT OR UPDATE OF agent_response ON public.test_executions
  FOR EACH ROW EXECUTE FUNCTION public.test_store_response();
DROP TRIGGER IF EXISTS z_test_preserve_response ON public.test_executions;
CREATE TRIGGER z_test_preserve_response BEFORE UPDATE OF actual_output ON public.test_executions
  FOR EACH ROW EXECUTE FUNCTION public.test_preserve_response();

-- Keep direct exports and the test dashboard on the same full row contract.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(CASE WHEN attname='agent_response' THEN 'public.test_read_response(t) AS agent_response'
    ELSE format('t.%I',attname) END,',' ORDER BY attnum) INTO cols
    FROM pg_attribute WHERE attrelid='public.test_executions'::regclass AND attnum>0 AND NOT attisdropped
      AND attname <> 'response_text_v1';
  EXECUTE format('CREATE OR REPLACE VIEW public.test_execution_results WITH (security_invoker=true) AS
    SELECT %s FROM public.test_executions t',cols);
END $$;
REVOKE ALL ON public.test_execution_results FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.test_execution_results TO service_role;
REVOKE ALL ON FUNCTION public.chat_read_payload(public.chat_messages),public.test_read_response(public.test_executions),
  public.chat_store_payload(),public.chat_preserve_payload(),public.test_store_response(),public.test_preserve_response()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_read_payload(public.chat_messages),public.test_read_response(public.test_executions) TO service_role;
NOTIFY pgrst,'reload schema';
