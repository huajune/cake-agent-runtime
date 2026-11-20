-- A pending roster row has no Auth identity and grants no access.
CREATE TABLE IF NOT EXISTS public.dashboard_accounts (
  phone text PRIMARY KEY CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  organization text NOT NULL CHECK (organization IN ('headquarters', 'henan')),
  disabled boolean NOT NULL DEFAULT false
);
ALTER TABLE public.dashboard_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dashboard_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.dashboard_accounts TO service_role;

-- Admin createUser supplies app metadata. Auth user creation and roster binding commit together.
CREATE OR REPLACE FUNCTION public.bind_dashboard_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  profile jsonb := NEW.raw_app_meta_data -> 'cake_dashboard_account';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.raw_app_meta_data ? 'cake_dashboard_account' THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO public.dashboard_accounts AS roster (phone, user_id, name, organization)
  VALUES ('+' || ltrim(NEW.phone, '+'), NEW.id, profile ->> 'name', profile ->> 'organization')
  ON CONFLICT (phone) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name
    WHERE roster.user_id IS NULL AND NOT roster.disabled AND roster.organization = EXCLUDED.organization;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dashboard account conflicts with the existing roster'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bind_dashboard_auth_user() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bind_dashboard_auth_user ON auth.users;
CREATE TRIGGER bind_dashboard_auth_user AFTER INSERT OR UPDATE OF raw_app_meta_data ON auth.users
FOR EACH ROW WHEN (NEW.raw_app_meta_data ? 'cake_dashboard_account')
EXECUTE FUNCTION public.bind_dashboard_auth_user();

-- Admin bans prevent future password logins. In-flight sessions consult the same status on
-- every protected request. Only dashboard identities are affected by this trigger.
CREATE OR REPLACE FUNCTION public.disable_banned_dashboard_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.dashboard_accounts SET disabled = true WHERE user_id = NEW.id AND NOT disabled;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.disable_banned_dashboard_account() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS disable_banned_dashboard_account ON auth.users;
CREATE TRIGGER disable_banned_dashboard_account AFTER UPDATE OF banned_until ON auth.users
FOR EACH ROW WHEN (NEW.banned_until > now() AND NEW.banned_until IS DISTINCT FROM OLD.banned_until)
EXECUTE FUNCTION public.disable_banned_dashboard_account();

-- Serialize removals of HQ privileges so two concurrent staff actions cannot remove every admin.
CREATE OR REPLACE FUNCTION public.keep_dashboard_headquarters_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(20261120, 1);
  IF NOT EXISTS (
    SELECT FROM public.dashboard_accounts
    WHERE organization = 'headquarters' AND NOT disabled AND user_id IS NOT NULL AND user_id <> OLD.user_id
  ) THEN RAISE EXCEPTION 'The dashboard needs an active headquarters account' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.keep_dashboard_headquarters_account() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS keep_dashboard_headquarters_account ON public.dashboard_accounts;
CREATE TRIGGER keep_dashboard_headquarters_account BEFORE UPDATE OF disabled, organization ON public.dashboard_accounts
FOR EACH ROW WHEN (OLD.user_id IS NOT NULL AND OLD.organization = 'headquarters' AND NOT OLD.disabled
  AND (NEW.organization <> 'headquarters' OR NEW.disabled))
EXECUTE FUNCTION public.keep_dashboard_headquarters_account();
