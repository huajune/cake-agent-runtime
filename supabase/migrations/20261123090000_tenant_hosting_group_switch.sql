-- Serialize a staff switch with ownership changes on the same Stride connection.
CREATE OR REPLACE FUNCTION public.set_tenant_hosting_group_blacklisted(
  p_connection_id text, p_tenant_id text, p_group_id text, p_blacklisted boolean, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
SET statement_timeout = '4s' SET lock_timeout = '3s' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('cake.hosting.' || p_connection_id, 0));
  IF NOT EXISTS (
    SELECT FROM public.hosting_current_groups
    WHERE connection_id = p_connection_id AND group_id = p_group_id AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION '无权操作此小组' USING ERRCODE = '42501';
  END IF;
  RETURN public.set_hosting_group_blacklisted(p_group_id, p_blacklisted, p_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.set_tenant_hosting_group_blacklisted(text, text, text, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_tenant_hosting_group_blacklisted(text, text, text, boolean, text)
  TO service_role;
