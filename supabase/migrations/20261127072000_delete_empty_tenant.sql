-- Restrictive foreign keys on members, group ownership and business records protect
-- their organization, including when a concurrent transaction is creating a reference.
CREATE OR REPLACE FUNCTION public.delete_empty_tenant(p_tenant_id text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH removed AS (
    DELETE FROM public.tenants WHERE id = p_tenant_id RETURNING id
  )
  SELECT EXISTS (SELECT FROM removed);
$$;

REVOKE ALL ON FUNCTION public.delete_empty_tenant(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_empty_tenant(text) TO service_role;
