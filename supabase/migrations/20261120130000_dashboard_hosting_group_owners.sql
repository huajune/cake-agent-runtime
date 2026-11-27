-- A phone login can own one Stride group. Its bots come from the live directory.
ALTER TABLE public.dashboard_accounts ADD COLUMN IF NOT EXISTS hosting_group_id text
  CHECK (hosting_group_id IS NULL OR (hosting_group_id = btrim(hosting_group_id) AND hosting_group_id <> ''));
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_accounts_hosting_group_owner
  ON public.dashboard_accounts (hosting_group_id) WHERE hosting_group_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.clear_transferred_dashboard_group() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.hosting_group_id := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clear_transferred_dashboard_group() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS clear_transferred_dashboard_group ON public.dashboard_accounts;
CREATE TRIGGER clear_transferred_dashboard_group BEFORE UPDATE OF organization ON public.dashboard_accounts
FOR EACH ROW WHEN (OLD.organization IS DISTINCT FROM NEW.organization)
EXECUTE FUNCTION public.clear_transferred_dashboard_group();

-- Reserve the whole batch together. The Auth trigger later claims the existing row by phone.
CREATE OR REPLACE FUNCTION public.import_dashboard_henan_roster(members jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  imported integer;
BEGIN
  INSERT INTO public.dashboard_accounts AS a (phone, name, organization, hosting_group_id)
  SELECT m.phone, m.name, 'henan', m.hosting_group_id
  FROM jsonb_to_recordset(members) AS m(phone text, name text, hosting_group_id text)
  ON CONFLICT (phone) DO UPDATE SET hosting_group_id =
    CASE WHEN a.disabled THEN a.hosting_group_id ELSE coalesce(a.hosting_group_id, EXCLUDED.hosting_group_id) END
  WHERE a.organization = EXCLUDED.organization AND a.name = EXCLUDED.name
    AND (a.hosting_group_id IS NULL OR EXCLUDED.hosting_group_id IS NULL OR a.hosting_group_id = EXCLUDED.hosting_group_id);
  GET DIAGNOSTICS imported = ROW_COUNT;
  IF imported <> jsonb_array_length(members) THEN
    RAISE EXCEPTION 'Roster identity or group ownership conflicts with an existing account' USING ERRCODE = '23514';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.import_dashboard_henan_roster(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_dashboard_henan_roster(jsonb) TO service_role;
