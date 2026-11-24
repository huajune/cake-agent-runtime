-- Run db push only after the backfill and application rollout. Drain old detail readers,
-- cleanup jobs and direct imports naming the old column before applying this contract.
-- Restore pre-cutover dumps into their matching schema before replaying these migrations.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = pg_catalog, public;
-- Normal reads continue during the empty-column check. Writers cannot race the final DROP.
LOCK TABLE public.message_processing_records IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='public.message_processing_records'::regclass
                 AND attname='agent_invocation' AND NOT attisdropped) THEN RETURN; END IF;
  IF EXISTS (SELECT FROM public.message_processing_records WHERE agent_invocation IS NOT NULL) THEN
    RAISE EXCEPTION 'Legacy snapshots remain. Rerun the verified backfill before retiring the column';
  END IF;
END $$;

-- The optional tenant feature adds this service-only view. Preserve its filter and
-- grants; abort on a different definition, extra grants, metadata or downstream dependencies.
DO $$
DECLARE
  target regclass := to_regclass('public.tenant_visible_message_processing_records');
  original_acl aclitem[];
  original_owner oid;
  service_privileges text;
  projected text;
  retained text;
BEGIN
  IF target IS NULL THEN RETURN; END IF;
  LOCK TABLE public.tenant_visible_message_processing_records IN ACCESS EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = target AND attname = 'agent_invocation'
                 AND attnum > 0 AND NOT attisdropped) THEN RETURN; END IF;
  SELECT relacl, relowner INTO original_acl, original_owner FROM pg_class WHERE oid = target
    AND relkind = 'v' AND reloptions = ARRAY['security_invoker=true'];
  IF original_owner IS DISTINCT FROM current_user::regrole::oid OR original_acl IS NULL
     OR obj_description(target, 'pg_class') IS NOT NULL
     OR EXISTS (SELECT FROM pg_attribute WHERE attrelid = target AND attnum > 0 AND
          (attacl IS NOT NULL OR atthasdef OR col_description(target, attnum) IS NOT NULL))
     OR EXISTS (SELECT FROM pg_rewrite WHERE ev_class = target AND rulename <> '_RETURN')
     OR EXISTS (SELECT FROM pg_trigger WHERE tgrelid = target AND NOT tgisinternal)
     OR EXISTS (SELECT FROM pg_seclabel WHERE classoid = 'pg_class'::regclass AND objoid = target)
     OR EXISTS (SELECT FROM aclexplode(original_acl) WHERE grantor <> original_owner OR
          (grantee <> original_owner AND (grantee <> 'service_role'::regrole::oid OR is_grantable))) THEN
    RAISE EXCEPTION 'Unrecognized tenant view metadata; preserve it before retrying';
  END IF;
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum),
         string_agg(quote_ident(attname), ', ' ORDER BY attnum) FILTER (WHERE attname <> 'agent_invocation')
    INTO projected, retained FROM pg_attribute
    WHERE attrelid = target AND attnum > 0 AND NOT attisdropped;
  EXECUTE format('CREATE TEMP VIEW expected_tenant_processing AS SELECT %s FROM public.message_processing_records WHERE tenant_id IS NOT NULL', projected);
  IF pg_get_viewdef(target) <> pg_get_viewdef('pg_temp.expected_tenant_processing'::regclass) THEN
    RAISE EXCEPTION 'Tenant view has a different projection or visibility filter';
  END IF;
  DROP VIEW pg_temp.expected_tenant_processing;
  SELECT string_agg(privilege_type, ', ' ORDER BY privilege_type) INTO service_privileges
    FROM aclexplode(original_acl) WHERE grantee = 'service_role'::regrole::oid;
  DROP VIEW public.tenant_visible_message_processing_records RESTRICT;
  EXECUTE format('CREATE VIEW public.tenant_visible_message_processing_records WITH (security_invoker=true) AS SELECT %s FROM public.message_processing_records WHERE tenant_id IS NOT NULL', retained);
  REVOKE ALL ON public.tenant_visible_message_processing_records FROM PUBLIC, anon, authenticated, service_role;
  IF service_privileges IS NOT NULL THEN
    EXECUTE format('GRANT %s ON public.tenant_visible_message_processing_records TO service_role', service_privileges);
  END IF;
  -- Compare ACLs independent of ordering, including default privileges granted in this database.
  IF (SELECT ARRAY(SELECT acl::text FROM unnest(original_acl) AS acl ORDER BY 1) IS DISTINCT FROM
             ARRAY(SELECT acl::text FROM unnest(relacl) AS acl ORDER BY 1)
        FROM pg_class WHERE oid = 'public.tenant_visible_message_processing_records'::regclass) THEN
    RAISE EXCEPTION 'Tenant view grants changed';
  END IF;
END $$;

-- DROP COLUMN can automatically remove a local index or constraint even with RESTRICT.
DO $$
DECLARE dependent text;
BEGIN
  SELECT pg_describe_object(d.classid, d.objid, d.objsubid) INTO dependent
  FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.refclassid = 'pg_class'::regclass AND a.attrelid = 'public.message_processing_records'::regclass
    AND a.attname = 'agent_invocation' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'Unexpected dependency on legacy invocation: %', dependent; END IF;
  -- PL/pgSQL bodies and SQL functions declared as strings have no column-level pg_depend entry.
  SELECT p.oid::regprocedure::text INTO dependent FROM pg_proc p
  WHERE p.prokind IN ('f','p') AND p.oid NOT IN (
    'public.processing_read_invocation(public.message_processing_invocations)'::regprocedure,
    'public.save_processing_snapshot(jsonb,jsonb)'::regprocedure,
    'public.processing_guard_tools()'::regprocedure
  ) AND p.oid IS DISTINCT FROM to_regprocedure('public.null_agent_invocation(integer,integer)')
  AND (p.prosrc ~* '\mnull_agent_invocation\M' OR (p.prosrc ~* '\magent_invocation\M' AND
       (p.prosrc ~* '\mmessage_processing_records\M' OR EXISTS (
          SELECT FROM pg_trigger t WHERE t.tgfoid=p.oid AND t.tgrelid='public.message_processing_records'::regclass))))
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'Check routine % for a legacy invocation dependency', dependent; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.processing_guard_tools() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF OLD.step_tools_v1 IS NOT NULL AND NEW.step_tools_v1 IS NOT DISTINCT FROM OLD.step_tools_v1 THEN
    IF NEW.agent_steps IS NOT DISTINCT FROM OLD.agent_steps THEN
      IF NEW.tool_calls IS DISTINCT FROM OLD.tool_calls THEN
        NEW.agent_steps := public.processing_read_steps(OLD);
        NEW.step_tools_v1 := NULL;
      END IF;
    ELSIF jsonb_typeof(NEW.agent_steps #> '{0,toolCalls}') IS DISTINCT FROM 'number' THEN
      -- A pre-upgrade writer replaced the step array without a codec marker.
      NEW.step_tools_v1 := NULL;
    END IF;
  END IF;
  IF (NEW.tool_calls IS DISTINCT FROM OLD.tool_calls OR NEW.chat_id IS DISTINCT FROM OLD.chat_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR (NEW.agent_steps IS DISTINCT FROM OLD.agent_steps
       AND public.processing_read_steps(NEW) IS DISTINCT FROM public.processing_read_steps(OLD)))
     AND NEW.invocation_version IS NOT DISTINCT FROM OLD.invocation_version THEN
    -- Keep the previous exact snapshot to its original expiry. Never attach it to a corrected master.
    IF EXISTS (SELECT 1 FROM public.message_processing_invocations i WHERE i.message_id=OLD.message_id
      AND i.response_tools_v1 IS NOT NULL AND (i.write_version IS DISTINCT FROM OLD.invocation_version
        OR i.response_tools_v1 IS DISTINCT FROM public.processing_tools_digest(OLD.tool_calls))) THEN
      RAISE EXCEPTION 'processing_invocation_reference_mismatch';
    END IF;
    UPDATE public.message_processing_invocations SET agent_invocation='null'::jsonb,
      superseded_invocation=CASE WHEN response_tools_v1 IS NULL THEN agent_invocation
        ELSE jsonb_set(agent_invocation,'{response,toolCalls}',OLD.tool_calls) END,
      response_tools_v1=NULL WHERE message_id=OLD.message_id AND superseded_invocation IS NULL;
    NEW.invocation_version := gen_random_uuid();
  END IF;
  RETURN NEW;
END $$;
DROP FUNCTION IF EXISTS public.null_agent_invocation(integer, integer) RESTRICT;
ALTER TABLE public.message_processing_records DROP COLUMN IF EXISTS agent_invocation RESTRICT;
NOTIFY pgrst, 'reload schema';
COMMIT;
