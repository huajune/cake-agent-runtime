-- PostgREST verifies the bearer JWT before this function runs. Read the current
-- session, verified Auth identity and membership together, on every request.
CREATE OR REPLACE FUNCTION public.current_dashboard_account()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'memberId', m.id, 'userId', m.user_id, 'loginName', m.login_name,
    'name', m.name, 'organization', m.organization, 'tenantRole', m.tenant_role,
    'phone', m.phone, 'disabled', m.disabled, 'hostingGroupId', m.hosting_group_id,
    'tenant', jsonb_build_object('name', t.name, 'readsAllTenants', t.reads_all_tenants)
  )
  FROM auth.sessions s
  JOIN auth.users u ON u.id = s.user_id
  JOIN public.tenant_members m ON m.user_id = u.id
  JOIN public.tenants t ON t.id = m.organization
  WHERE s.id = nullif(auth.jwt()->>'session_id', '')::uuid
    AND u.id = auth.uid()
    AND (s.not_after IS NULL OR s.not_after > now())
    AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= now())
    AND NOT m.disabled
    AND (
      (m.login_name IS NULL AND u.phone_confirmed_at IS NOT NULL
        AND m.phone = '+' || ltrim(nullif(u.phone, ''), '+'))
      OR (m.login_name = 'cakeadmin' AND m.organization = 'headquarters'
        AND nullif(u.phone, '') IS NULL AND u.email = 'cakeadmin@dashboard.cake.invalid'
        AND u.email_confirmed_at IS NOT NULL
        AND u.raw_app_meta_data #>> '{cake_dashboard_account,login_name}' = 'cakeadmin')
    );
$$;
REVOKE ALL ON FUNCTION public.current_dashboard_account() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.current_dashboard_account() TO authenticated;
