-- Run with psql against an empty disposable database with the three Supabase API roles.
\set ON_ERROR_STOP on
CREATE TABLE public.strategy_config (id uuid PRIMARY KEY);
\ir ../../../supabase/migrations/20260319000000_add_strategy_changelog.sql

INSERT INTO public.strategy_config VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO public.strategy_config_changelog (config_id, field, old_value, new_value, changed_by)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'persona', NULL, '{"label":"初稿"}', NULL),
  ('00000000-0000-0000-0000-000000000001', 'persona', '{"label":"初稿"}', '{"label":"修订"}', 'operator');
CREATE TEMP TABLE expected AS TABLE public.strategy_config_changelog;

\ir ../../../supabase/migrations/20261124024135_archive_strategy_config_changelog.sql
\ir ../../../supabase/migrations/20261124024135_archive_strategy_config_changelog.sql
DO $$
BEGIN
  IF to_regclass('public.strategy_config_changelog') IS NOT NULL THEN
    RAISE EXCEPTION 'The retired table still exists in the API schema';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS roles(name)
    WHERE has_schema_privilege(name, 'strategy_archive', 'USAGE')
      OR has_table_privilege(name, 'strategy_archive.strategy_config_changelog', 'SELECT')
      OR has_table_privilege(name, 'strategy_archive.strategy_config_changelog', 'INSERT')
  ) THEN
    RAISE EXCEPTION 'An API role can access the archive';
  END IF;
END;
$$;

\ir ../../../scripts/sql/restore-strategy-changelog.sql
DO $$
BEGIN
  IF EXISTS (
    (TABLE expected EXCEPT ALL TABLE public.strategy_config_changelog)
    UNION ALL
    (TABLE public.strategy_config_changelog EXCEPT ALL TABLE expected)
  ) THEN
    RAISE EXCEPTION 'Recovered rows must match the original rows exactly';
  END IF;
END;
$$;

DELETE FROM public.strategy_config;
DO $$
BEGIN
  IF EXISTS (SELECT FROM public.strategy_config_changelog)
     OR (SELECT count(*) FROM strategy_archive.strategy_config_changelog) <> 2 THEN
    RAISE EXCEPTION 'Deleting a live strategy must leave its archive intact';
  END IF;
END;
$$;
