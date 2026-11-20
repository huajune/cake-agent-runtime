-- Organization is the tenant. Keep existing account IDs and the public account API stable.
CREATE TABLE IF NOT EXISTS public.tenants (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text CHECK (id = btrim(id) AND id <> ''),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.tenants (id, name) VALUES
  ('headquarters', '总部'), ('henan', '河南自招中心'), ('shanghai_recruitment', '上海自招团队')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.dashboard_accounts DROP CONSTRAINT IF EXISTS dashboard_accounts_organization_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='public.dashboard_accounts'::regclass
                 AND conname='dashboard_accounts_tenant_fk') THEN
    ALTER TABLE public.dashboard_accounts ADD CONSTRAINT dashboard_accounts_tenant_fk
      FOREIGN KEY (organization) REFERENCES public.tenants(id);
  END IF;
END $$;

-- Each entry takes effect until the next entry for the same external identity. A NULL
-- destination explicitly ends a binding. Empty groups can therefore be registered independently.
CREATE TABLE IF NOT EXISTS public.hosting_group_ownership (
  connection_id text NOT NULL CHECK (connection_id = btrim(connection_id) AND connection_id <> ''),
  group_id text NOT NULL CHECK (group_id = btrim(group_id) AND group_id <> ''),
  effective_from timestamptz NOT NULL CHECK (isfinite(effective_from)),
  tenant_id text REFERENCES public.tenants(id),
  PRIMARY KEY (connection_id, group_id, effective_from)
);
CREATE TABLE IF NOT EXISTS public.hosting_bot_memberships (
  connection_id text NOT NULL CHECK (connection_id = btrim(connection_id) AND connection_id <> ''),
  bot_im_id text NOT NULL CHECK (bot_im_id = btrim(bot_im_id) AND bot_im_id <> ''),
  effective_from timestamptz NOT NULL CHECK (isfinite(effective_from)),
  group_id text CHECK (group_id = btrim(group_id) AND group_id <> ''),
  PRIMARY KEY (connection_id, bot_im_id, effective_from)
);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_group_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_bot_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenants, public.hosting_group_ownership, public.hosting_bot_memberships
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.tenants, public.hosting_group_ownership, public.hosting_bot_memberships TO service_role;

-- First observation is effective from this transaction. A discrepant or retired identity
-- needs a separately verified transfer date. Re-running onboarding never rewrites history.
CREATE OR REPLACE FUNCTION public.register_hosting_directory(
  p_connection_id text, p_groups jsonb, p_check_only boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE g record; bot text; prev text; observed_at timestamptz;
BEGIN
  IF nullif(btrim(p_connection_id),'') IS NULL OR p_connection_id<>btrim(p_connection_id)
    OR jsonb_typeof(p_groups) IS DISTINCT FROM 'array' OR jsonb_array_length(p_groups) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid hosting directory';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.' || p_connection_id, 0));
  observed_at := clock_timestamp();
  IF EXISTS (SELECT FROM jsonb_array_elements(p_groups) item GROUP BY item.value->>'group_id' HAVING count(*)>1)
    OR EXISTS (SELECT FROM jsonb_array_elements(p_groups) item, jsonb_array_elements_text(item.value->'bot_im_ids') b
               GROUP BY b.value HAVING count(*)>1) THEN RAISE EXCEPTION 'duplicate directory identity'; END IF;
  FOR g IN SELECT * FROM jsonb_to_recordset(p_groups) AS x(group_id text,tenant_id text,bot_im_ids text[]) LOOP
    IF nullif(btrim(g.group_id),'') IS NULL OR g.group_id<>btrim(g.group_id) OR g.bot_im_ids IS NULL OR
      NOT EXISTS (SELECT FROM public.tenants t WHERE t.id=g.tenant_id) THEN RAISE EXCEPTION 'invalid tenant or group'; END IF;
    SELECT h.tenant_id INTO prev FROM public.hosting_group_ownership h
      WHERE h.connection_id=p_connection_id AND h.group_id=g.group_id AND h.effective_from<=observed_at
      ORDER BY h.effective_from DESC LIMIT 1;
    IF FOUND THEN
      IF prev IS DISTINCT FROM g.tenant_id THEN RAISE EXCEPTION 'verify the group transfer date'; END IF;
    ELSIF p_check_only IS FALSE THEN
      INSERT INTO public.hosting_group_ownership VALUES(p_connection_id,g.group_id,observed_at,g.tenant_id);
    END IF;
    FOREACH bot IN ARRAY g.bot_im_ids LOOP
      IF nullif(btrim(bot),'') IS NULL OR bot<>btrim(bot) THEN RAISE EXCEPTION 'invalid bot identity'; END IF;
      SELECT b.group_id INTO prev FROM public.hosting_bot_memberships b
        WHERE b.connection_id=p_connection_id AND b.bot_im_id=bot AND b.effective_from<=observed_at
        ORDER BY b.effective_from DESC LIMIT 1;
      IF FOUND THEN
        IF prev IS DISTINCT FROM g.group_id THEN RAISE EXCEPTION 'verify the bot transfer date'; END IF;
      ELSIF p_check_only IS FALSE THEN
        INSERT INTO public.hosting_bot_memberships VALUES(p_connection_id,bot,observed_at,g.group_id);
      END IF;
    END LOOP;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.register_hosting_directory(text,jsonb,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_hosting_directory(text,jsonb,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.hosting_tenant_at(
  p_connection_id text, p_bot_im_id text, p_group_id text, p_occurred_at timestamptz
) RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  assigned_group text;
  target_group text;
BEGIN
  SELECT m.group_id INTO assigned_group FROM public.hosting_bot_memberships m
    WHERE m.connection_id=p_connection_id AND m.bot_im_id=p_bot_im_id AND m.effective_from<=p_occurred_at
    ORDER BY m.effective_from DESC LIMIT 1;
  -- p_group_id is the verified original event group. A current directory observation is
  -- never passed as old event evidence. A known removal or a conflicting binding stays unresolved.
  IF FOUND AND (assigned_group IS NULL OR (p_group_id IS NOT NULL AND p_group_id<>assigned_group)) THEN
    RETURN NULL;
  END IF;
  target_group := coalesce(p_group_id, assigned_group);
  RETURN (SELECT g.tenant_id FROM public.hosting_group_ownership g
    WHERE g.connection_id=p_connection_id AND g.group_id=target_group AND g.effective_from<=p_occurred_at
    ORDER BY g.effective_from DESC LIMIT 1);
END $$;

ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS hosting_connection_id text,
  ADD COLUMN IF NOT EXISTS hosting_group_id text,
  ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES public.tenants(id);
COMMENT ON COLUMN public.chat_messages.tenant_id IS '业务发生时的蛋糕租户，NULL 表示归属待核对';

CREATE OR REPLACE FUNCTION public.assign_chat_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE resolved text;
BEGIN
  IF TG_OP='UPDATE' AND OLD.tenant_id IS NOT NULL THEN
    IF ROW(NEW.tenant_id, NEW.hosting_connection_id, NEW.hosting_group_id, NEW.im_bot_id, NEW.timestamp)
       IS DISTINCT FROM ROW(OLD.tenant_id, OLD.hosting_connection_id, OLD.hosting_group_id, OLD.im_bot_id, OLD.timestamp) THEN
      RAISE EXCEPTION 'chat tenant and its ownership evidence are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.hosting_connection_id IS NOT NULL THEN
    resolved := public.hosting_tenant_at(NEW.hosting_connection_id, NEW.im_bot_id, NEW.hosting_group_id, NEW.timestamp);
  END IF;
  IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM resolved THEN
    RAISE EXCEPTION 'chat tenant is inconsistent with the registered ownership' USING ERRCODE='23514';
  END IF;
  NEW.tenant_id := resolved;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS assign_chat_tenant ON public.chat_messages;
CREATE TRIGGER assign_chat_tenant BEFORE INSERT OR UPDATE OF tenant_id, hosting_connection_id, hosting_group_id, im_bot_id, timestamp
  ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION public.assign_chat_tenant();

-- The operator supplies a verified source and a bounded list of historical message IDs.
-- A dry run is the default. Neither mode guesses a source from a nickname or a current group.
CREATE OR REPLACE FUNCTION public.backfill_chat_tenants(
  p_connection_id text, p_message_ids text[], p_apply boolean DEFAULT false
) RETURNS TABLE (requested integer, matched integer, assignable integer, applied integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET statement_timeout = '4s' AS $$
DECLARE eligible_ids text[];
BEGIN
  IF nullif(btrim(p_connection_id),'') IS NULL OR p_connection_id<>btrim(p_connection_id)
    OR coalesce(cardinality(p_message_ids),0) NOT BETWEEN 1 AND 500 OR array_position(p_message_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'supply a verified connection and 1 to 500 non-null message IDs';
  END IF;
  WITH ids AS (SELECT DISTINCT unnest(p_message_ids) AS id)
  SELECT count(*)::integer, count(c.message_id)::integer, coalesce(array_agg(c.message_id) FILTER (
    WHERE c.message_id IS NOT NULL AND c.tenant_id IS NULL
      AND (c.hosting_connection_id IS NULL OR c.hosting_connection_id=p_connection_id)
      AND public.hosting_tenant_at(p_connection_id,c.im_bot_id,c.hosting_group_id,c.timestamp) IS NOT NULL
  ), '{}'::text[])
  INTO requested, matched, eligible_ids FROM ids LEFT JOIN public.chat_messages c ON c.message_id=ids.id;
  assignable := cardinality(eligible_ids);
  applied := 0;
  IF p_apply IS TRUE AND assignable>0 THEN
    WITH changed AS (
      UPDATE public.chat_messages c SET hosting_connection_id=p_connection_id
      WHERE c.message_id=ANY(eligible_ids) AND c.tenant_id IS NULL
        AND (c.hosting_connection_id IS NULL OR c.hosting_connection_id=p_connection_id)
        AND public.hosting_tenant_at(p_connection_id,c.im_bot_id,c.hosting_group_id,c.timestamp) IS NOT NULL
      RETURNING c.tenant_id
    ) SELECT count(tenant_id)::integer INTO applied FROM changed;
  END IF;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.hosting_tenant_at(text,text,text,timestamptz), public.assign_chat_tenant(),
  public.backfill_chat_tenants(text,text[],boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hosting_tenant_at(text,text,text,timestamptz), public.assign_chat_tenant(),
  public.backfill_chat_tenants(text,text[],boolean) TO service_role;
