-- Login removal must never cascade into a member profile or its hosting assignments.
ALTER TABLE public.tenant_members DROP CONSTRAINT tenant_members_user_id_fkey;
ALTER TABLE public.tenant_members ADD CONSTRAINT tenant_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.disable_banned_dashboard_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE is_banned boolean := coalesce(NEW.banned_until > now(), false);
BEGIN
  UPDATE public.tenant_members SET disabled = is_banned
    WHERE user_id = NEW.id AND disabled IS DISTINCT FROM is_banned;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS disable_banned_dashboard_account ON auth.users;
CREATE TRIGGER disable_banned_dashboard_account AFTER UPDATE OF banned_until ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.disable_banned_dashboard_account();

CREATE OR REPLACE FUNCTION public.delete_disabled_dashboard_login(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE member public.tenant_members%ROWTYPE;
BEGIN
  -- Same lock order as the Auth ban/unban trigger. A racing restore or delete
  -- either sees the committed change or completes before we check the status.
  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO member FROM public.tenant_members WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT member.disabled OR member.login_name IS NOT NULL THEN
    RAISE EXCEPTION 'Only disabled employee logins may be removed' USING ERRCODE = '23514';
  END IF;
  UPDATE public.tenant_members SET user_id = NULL, disabled = false WHERE id = member.id;
  DELETE FROM auth.users WHERE id = p_user_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.delete_disabled_dashboard_login(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_disabled_dashboard_login(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
